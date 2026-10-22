const { verifyToken } = require('../utils/jwt');
const { pool } = require('../db');
const { sendPushToUser } = require('../push');
const callState = require('../calls');
const {
  memberIds, isOnline, emitToMembers, contactIds, isChatBlocked, getShowLastSeen, insertTextMessage,
} = require('../realtime');

/**
 * Wires Socket.IO onto an existing http.Server + Express app.
 * Every connection must present a valid JWT — anonymous sockets are
 * rejected before any handler runs.
 */
function attachSockets(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('unauthorized'));
    try {
      const payload = verifyToken(token);
      socket.userId = payload.sub;
      socket.userHandle = payload.handle;
      socket.sessionId = payload.sid || null;
      return next();
    } catch (err) {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    console.log(`socket connected: ${socket.userHandle} (${socket.id})`);

    const wasOnline = isOnline(io, socket.userId);
    socket.join(`user:${socket.userId}`);
    if (!wasOnline) broadcastPresence(io, socket.userId, true);
    if (socket.sessionId) {
      pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [socket.sessionId]).catch(() => {});
    }

    // Çalmakta olan aramalar (bağlantı yeni kurulduysa kaçırılmasın).
    callState.replayPendingInvite(socket);
    callState.replayGroupRinging(socket).catch(() => {});

    // Kept for older clients; live delivery now goes through the personal
    // `user:<id>` room, so joining chat rooms is no longer required.
    socket.on('chat:join', () => {});

    // "yazıyor…": {chatId, typing: boolean}. Kalıcı değildir; yalnızca çevrimiçi diğer üyelere aktarılır.
    // Engellenmiş sohbette aktarılmaz. İstemci yazarken ~3 sn'de bir gönderir ve durunca typing:false yollar;
    // alıcı 6 sn içinde yenisi gelmezse göstergeyi kendisi kapatır (bağlantı kopsa da takılı kalmaz).
    socket.on('chat:typing', async (payload) => {
      try {
        const { chatId, typing } = payload || {};
        if (!chatId || typeof chatId !== 'string') return;
        if (!(await assertMember(chatId, socket.userId))) return;
        if (await isChatBlocked(chatId, socket.userId)) return;
        if (!socket.displayName) {
          const u = await pool.query('SELECT display_name FROM users WHERE id = $1', [socket.userId]);
          socket.displayName = u.rows[0]?.display_name || socket.userHandle;
        }
        const ids = await memberIds(chatId);
        ids.filter((id) => id !== socket.userId).forEach((id) => {
          io.to(`user:${id}`).emit('chat:typing', {
            chatId, userId: socket.userId, name: socket.displayName, typing: typing === true,
          });
        });
      } catch (err) {
        console.error('typing error (non-fatal)', err);
      }
    });
    socket.on('chat:leave', () => {});

    socket.on('message:send', async (payload, ack) => {
      try {
        const { chatId, text, replyToId, forwarded } = payload || {};
        if (!chatId || !text || typeof text !== 'string' || text.length > 60000) {
          return ack?.({ ok: false, error: 'invalid payload' });
        }
        if (!(await assertMember(chatId, socket.userId))) return ack?.({ ok: false, error: 'forbidden' });
        if (await isChatBlocked(chatId, socket.userId)) return ack?.({ ok: false, error: 'blocked' });

        const result = await insertTextMessage({
          chatId, senderId: socket.userId, text, replyToId: typeof replyToId === 'string' ? replyToId : null, forwarded: forwarded === true,
        });
        if (result.error) return ack?.({ ok: false, error: result.error });
        const { message } = result;
        await emitToMembers(io, chatId, 'message:new', message);
        ack?.({ ok: true, message });
        notifyOtherMembers(io, chatId, socket.userId, message);
      } catch (err) {
        console.error('message:send error', err);
        ack?.({ ok: false, error: 'server error' });
      }
    });

    // --- WebRTC call signaling (relay only; media never touches this server)
    socket.on('call:invite', async ({ chatId, targetUserId, callType, sdpOffer }) => {
      if (!(await assertMember(chatId, socket.userId))) return;
      if (!(await assertMember(chatId, targetUserId))) return;
      if (await isChatBlocked(chatId, socket.userId)) return;
      // Geçmiş kaydı: varsayılan MISSED; yanıtlanırsa ANSWERED, reddedilirse DECLINED olur.
      // Önce kaydı yaz (await): cevap/ret çok hızlı gelirse güncelleme satırı bulabilsin.
      await pool.query(
        'INSERT INTO call_logs (caller_id, callee_id, chat_id, call_type) VALUES ($1, $2, $3, $4)',
        [socket.userId, targetUserId, chatId, String(callType).toUpperCase() === 'VIDEO' ? 'VIDEO' : 'AUDIO'],
      ).catch((err) => console.error('call log insert error (non-fatal)', err));
      const invitePayload = {
        chatId, fromUserId: socket.userId, fromHandle: socket.userHandle, callType, sdpOffer,
      };
      callState.registerInvite(io, targetUserId, invitePayload, () => {
        // Yanıt gelmedi: kayıt MISSED kalır, yalnızca bitiş zamanı yazılır.
        updateOpenCall(socket.userId, targetUserId, 'ended_at = now()');
      });
      io.to(`user:${targetUserId}`).emit('call:invite', invitePayload);
    });
    socket.on('call:answer', ({ targetUserId, sdpAnswer }) => {
      callState.clearPendingBetween(socket.userId, targetUserId);
      updateOpenCall(socket.userId, targetUserId, "status = 'ANSWERED', answered_at = now()");
      io.to(`user:${targetUserId}`).emit('call:answer', { fromUserId: socket.userId, sdpAnswer });
    });
    socket.on('call:ice-candidate', ({ targetUserId, candidate }) => {
      callState.bufferIce(targetUserId, socket.userId, candidate);
      io.to(`user:${targetUserId}`).emit('call:ice-candidate', { fromUserId: socket.userId, candidate });
    });
    socket.on('call:decline', ({ targetUserId }) => {
      callState.clearPendingBetween(socket.userId, targetUserId);
      updateOpenCall(socket.userId, targetUserId, "status = 'DECLINED', ended_at = now()");
      io.to(`user:${targetUserId}`).emit('call:decline', { fromUserId: socket.userId });
    });
    socket.on('call:end', ({ targetUserId }) => {
      callState.clearPendingBetween(socket.userId, targetUserId);
      updateOpenCall(socket.userId, targetUserId, 'ended_at = now()');
      io.to(`user:${targetUserId}`).emit('call:end', { fromUserId: socket.userId });
    });

    // --- Grup araması (mesh, sesli): başlat/katıl, ayrıl, sinyal ilet ---
    socket.on('gcall:join', async ({ chatId, video } = {}, ack) => {
      try {
        if (typeof chatId !== 'string') return ack?.({ ok: false, error: 'invalid' });
        const result = await callState.joinGroupCall(io, socket.userId, chatId, { video: video === true });
        if (result.error) return ack?.({ ok: false, error: result.error });
        return ack?.({
          ok: true, created: result.created, participants: result.existing, video: result.room.video,
          max: result.room.video ? callState.MAX_GROUP_VIDEO_PARTICIPANTS : callState.MAX_GROUP_PARTICIPANTS,
        });
      } catch (err) {
        console.error('gcall:join error', err);
        return ack?.({ ok: false, error: 'server error' });
      }
    });
    socket.on('gcall:leave', async ({ chatId } = {}) => {
      if (typeof chatId === 'string') await callState.leaveGroupCall(io, socket.userId, chatId).catch(() => {});
    });
    socket.on('gcall:signal', ({ chatId, targetUserId, data } = {}) => {
      if (typeof chatId !== 'string' || typeof targetUserId !== 'string' || !data) return;
      callState.relayGroupSignal(io, socket.userId, chatId, targetUserId, data);
    });

    socket.on('disconnect', () => {
      console.log(`socket disconnected: ${socket.userHandle} (${socket.id})`);
      if (!isOnline(io, socket.userId)) callState.leaveAllGroupCalls(io, socket.userId).catch(() => {});
      if (!isOnline(io, socket.userId)) broadcastPresence(io, socket.userId, false);
    });
  });
}

/** İki kişi arasındaki en son açık (bitmemiş, 2 saatten yeni) arama kaydını günceller. */
function updateOpenCall(userA, userB, setSql) {
  if (typeof userB !== 'string') return;
  pool.query(
    `UPDATE call_logs SET ${setSql}
      WHERE id = (SELECT id FROM call_logs
                   WHERE ((caller_id = $1 AND callee_id = $2) OR (caller_id = $2 AND callee_id = $1))
                     AND ended_at IS NULL AND started_at > now() - interval '2 hours'
                   ORDER BY started_at DESC LIMIT 1)`,
    [userA, userB],
  ).catch((err) => console.error('call log update error (non-fatal)', err));
}

async function broadcastPresence(io, userId, online) {
  try {
    // Real privacy enforcement, not just a UI label: if the user turned
    // this off, no presence event leaves the server for them at all.
    if (!(await getShowLastSeen(userId))) return;
    const ids = await contactIds(userId);
    ids.forEach((id) => io.to(`user:${id}`).emit('presence:update', { userId, online }));
  } catch (err) {
    console.error('broadcastPresence error (non-fatal)', err);
  }
}

async function assertMember(chatId, userId) {
  const r = await pool.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  return r.rows.length > 0;
}

/** Push only to members who have no live socket (i.e. the app isn't open). */
async function notifyOtherMembers(io, chatId, senderId, message) {
  try {
    const sender = await pool.query('SELECT display_name FROM users WHERE id = $1', [senderId]);
    const senderName = sender.rows[0]?.display_name || 'SipChat';
    const fullBody = message.type === 'TEXT'
      // E2E payloads are ciphertext the server can't read — don't leak them into a notification.
      ? (String(message.text || '').startsWith('sipchat-e2e-v1:') ? 'Yeni şifreli mesaj' : String(message.text || '').slice(0, 120))
      : message.type === 'VOICE' ? 'Sesli mesaj gönderdi'
        : message.type === 'IMAGE' ? 'Fotoğraf gönderdi'
          : message.type === 'VIDEO' ? 'Video gönderdi' : 'Dosya gönderdi';

    const ids = (await memberIds(chatId)).filter((id) => id !== senderId && !isOnline(io, id));
    if (ids.length === 0) return;

    // "Mesaj Önizlemeleri" is each RECIPIENT's own lock-screen privacy
    // choice, so it's looked up per-recipient, not per-sender.
    const settings = await pool.query(
      'SELECT user_id, message_previews_enabled FROM user_settings WHERE user_id = ANY($1)',
      [ids],
    );
    const previewEnabled = new Map(settings.rows.map((r) => [r.user_id, r.message_previews_enabled]));

    await Promise.all(ids.map((id) => {
      const showPreview = previewEnabled.get(id) ?? true;
      return sendPushToUser(id, {
        title: showPreview ? senderName : 'SipChat',
        body: showPreview ? fullBody : 'Yeni bir mesajınız var',
        data: { chatId, type: 'message' },
      });
    }));
  } catch (err) {
    console.error('notifyOtherMembers error (non-fatal)', err);
  }
}

/**
 * "Kaybolan Mesajlar": sweeps every chat with a non-null disappear_seconds
 * and deletes messages older than that, notifying any connected members so
 * their UI drops the message live (not just on next refresh). Call once
 * after the server starts; it re-checks every [intervalMs].
 */
function startDisappearingMessagesSweep(io, intervalMs = 60_000) {
  const sweep = async () => {
    try {
      const result = await pool.query(
        `DELETE FROM messages m USING chats c
          WHERE m.chat_id = c.id AND c.disappear_seconds IS NOT NULL
            AND m.created_at < now() - (c.disappear_seconds || ' seconds')::interval
         RETURNING m.id, m.chat_id`,
      );
      for (const row of result.rows) {
        // eslint-disable-next-line no-await-in-loop
        await emitToMembers(io, row.chat_id, 'message:deleted', { chatId: row.chat_id, messageId: row.id });
      }
      // Süresi dolan durumları (24 saat) sil.
      await pool.query('DELETE FROM statuses WHERE expires_at <= now()');
    } catch (err) {
      console.error('disappearing messages sweep error (non-fatal)', err);
    }
  };
  sweep();
  return setInterval(sweep, intervalMs);
}

module.exports = { attachSockets, notifyOtherMembers, startDisappearingMessagesSweep };
