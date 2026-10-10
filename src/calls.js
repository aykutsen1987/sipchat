// Arama durumu (bellekte, sinyalleşme için): bekleyen 1:1 davetler ve grup (mesh) arama odaları.
// Medya sunucudan geçmez. Süreç yeniden başlarsa aktif aramalar zaten kopar; kalıcı tutulmaz.
const { pool } = require('./db');
const { isOnline } = require('./realtime');
const { sendPushToUser } = require('./push');

const RING_TIMEOUT_MS = Number(process.env.CALL_RING_TIMEOUT_MS) || 45_000;
const MAX_BUFFERED_ICE = 60;
const MAX_GROUP_PARTICIPANTS = 6;

// ---------------------------------------------------------------------------
// 1:1 — bekleyen davet (çalma süresi boyunca). Aranan o sırada çevrimdışıysa ya da
// bağlantısı yeniden kuruluyorsa, bağlanınca davet ve o ana kadarki ICE adayları
// yeniden iletilir; 45 sn içinde yanıt yoksa iki tarafa "call:unanswered" gider.
// ---------------------------------------------------------------------------
const pendingInvites = new Map(); // calleeId -> { payload, ice: [], timer }

function clearPendingFor(calleeId) {
  const p = pendingInvites.get(calleeId);
  if (p) { clearTimeout(p.timer); pendingInvites.delete(calleeId); }
}

/** a ile b arasındaki bekleyen daveti (hangisi aranansa) temizler. */
function clearPendingBetween(a, b) {
  const pa = pendingInvites.get(a);
  if (pa && pa.payload.fromUserId === b) clearPendingFor(a);
  const pb = pendingInvites.get(b);
  if (pb && pb.payload.fromUserId === a) clearPendingFor(b);
}

function registerInvite(io, calleeId, payload, onTimeout) {
  clearPendingFor(calleeId);
  const timer = setTimeout(() => {
    pendingInvites.delete(calleeId);
    io.to(`user:${calleeId}`).emit('call:unanswered', { fromUserId: payload.fromUserId });
    io.to(`user:${payload.fromUserId}`).emit('call:unanswered', { fromUserId: calleeId });
    onTimeout?.();
  }, RING_TIMEOUT_MS);
  timer.unref?.();
  pendingInvites.set(calleeId, { payload, ice: [], timer });

  // Çevrimdışıysa (Firebase yapılandırılmışsa) bildirim gönder; yapılandırılmamışsa sessizce atlanır.
  if (!isOnline(io, calleeId)) {
    sendPushToUser(calleeId, { title: 'Gelen arama', body: `@${payload.fromHandle} sizi arıyor` });
  }
}

function bufferIce(calleeId, fromUserId, candidate) {
  const p = pendingInvites.get(calleeId);
  if (p && p.payload.fromUserId === fromUserId && p.ice.length < MAX_BUFFERED_ICE) p.ice.push(candidate);
}

/** Bağlanan kullanıcıya beklemedeki daveti (varsa) yeniden gönderir. */
function replayPendingInvite(socket) {
  const p = pendingInvites.get(socket.userId);
  if (!p) return;
  socket.emit('call:invite', p.payload);
  p.ice.forEach((candidate) => socket.emit('call:ice-candidate', { fromUserId: p.payload.fromUserId, candidate }));
}

// ---------------------------------------------------------------------------
// Grup araması: tam örgü (mesh) sesli arama. Her katılımcı diğerleriyle doğrudan
// WebRTC bağlantısı kurar; sunucu yalnızca oda üyeliğini tutar ve sinyalleri iletir.
// Yeni katılan herkes, odadaki mevcut katılımcılara teklif (offer) gönderir.
// ---------------------------------------------------------------------------
const groupCalls = new Map(); // chatId -> { chatId, title, startedAt, participants: Map(userId -> {handle, displayName}) }

const publicParticipants = (room, exceptUserId) => [...room.participants.entries()]
  .filter(([id]) => id !== exceptUserId)
  .map(([id, p]) => ({ userId: id, handle: p.handle, displayName: p.displayName }));

async function groupInfo(chatId, userId) {
  const r = await pool.query(
    `SELECT c.title, c.kind, u.handle, u.display_name
       FROM chats c JOIN chat_members m ON m.chat_id = c.id AND m.user_id = $2 JOIN users u ON u.id = m.user_id
      WHERE c.id = $1`,
    [chatId, userId],
  );
  return r.rows[0] || null;
}

async function memberIdsOf(chatId) {
  const r = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
  return r.rows.map((x) => x.user_id);
}

/** Oda yoksa oluşturur; kullanıcıyı ekler. Dönüş: { room, existing, created } ya da { error }. */
async function joinGroupCall(io, userId, chatId) {
  const info = await groupInfo(chatId, userId);
  if (!info) return { error: 'forbidden' };
  if (info.kind !== 'GROUP') return { error: 'not-a-group' };

  let room = groupCalls.get(chatId);
  const created = !room;
  if (!room) {
    room = { chatId, title: info.title, startedAt: Date.now(), participants: new Map() };
    groupCalls.set(chatId, room);
  }
  if (!room.participants.has(userId) && room.participants.size >= MAX_GROUP_PARTICIPANTS) return { error: 'full' };

  const existing = publicParticipants(room, userId);
  const me = { userId, handle: info.handle, displayName: info.display_name };
  room.participants.set(userId, { handle: info.handle, displayName: info.display_name });

  // Odadakilere: biri katıldı (teklifi o gönderecek).
  existing.forEach((p) => io.to(`user:${p.userId}`).emit('gcall:participant-joined', { chatId, ...me }));

  if (created) {
    // Diğer üyelere "grup araması çalıyor".
    const members = (await memberIdsOf(chatId)).filter((id) => id !== userId);
    members.forEach((id) => {
      io.to(`user:${id}`).emit('gcall:ringing', { chatId, title: info.title, fromUserId: userId, fromHandle: info.handle, fromName: info.display_name });
      if (!isOnline(io, id)) {
        sendPushToUser(id, { title: info.title, body: `${info.display_name} grup araması başlattı` });
      }
    });
  }
  return { room, existing, created };
}

async function leaveGroupCall(io, userId, chatId) {
  const room = groupCalls.get(chatId);
  if (!room || !room.participants.has(userId)) return;
  room.participants.delete(userId);
  room.participants.forEach((_, id) => io.to(`user:${id}`).emit('gcall:participant-left', { chatId, userId }));
  if (room.participants.size === 0) {
    groupCalls.delete(chatId);
    const members = await memberIdsOf(chatId);
    members.forEach((id) => io.to(`user:${id}`).emit('gcall:ended', { chatId }));
  }
}

/** Kullanıcının tüm odalardan düşürülmesi (bağlantı koptuğunda). */
async function leaveAllGroupCalls(io, userId) {
  for (const [chatId, room] of groupCalls) {
    if (room.participants.has(userId)) {
      // eslint-disable-next-line no-await-in-loop
      await leaveGroupCall(io, userId, chatId);
    }
  }
}

function relayGroupSignal(io, fromUserId, chatId, targetUserId, data) {
  const room = groupCalls.get(chatId);
  if (!room || !room.participants.has(fromUserId) || !room.participants.has(targetUserId)) return false;
  io.to(`user:${targetUserId}`).emit('gcall:signal', { chatId, fromUserId, data });
  return true;
}

/** Bağlanan kullanıcıya, üyesi olduğu ve henüz içinde olmadığı aktif grup aramalarını bildirir. */
async function replayGroupRinging(socket) {
  if (groupCalls.size === 0) return;
  const r = await pool.query(
    'SELECT chat_id FROM chat_members WHERE user_id = $1 AND chat_id = ANY($2::uuid[])',
    [socket.userId, [...groupCalls.keys()]],
  );
  r.rows.forEach(({ chat_id: chatId }) => {
    const room = groupCalls.get(chatId);
    if (!room || room.participants.has(socket.userId)) return;
    const first = [...room.participants.entries()][0];
    socket.emit('gcall:ringing', { chatId, title: room.title, fromUserId: first?.[0], fromHandle: first?.[1].handle, fromName: first?.[1].displayName });
  });
}

module.exports = {
  registerInvite, clearPendingBetween, bufferIce, replayPendingInvite,
  joinGroupCall, leaveGroupCall, leaveAllGroupCalls, relayGroupSignal, replayGroupRinging,
  publicParticipants, MAX_GROUP_PARTICIPANTS,
};
