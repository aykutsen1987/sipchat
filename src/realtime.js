const { pool } = require('./db');

/** All user ids that belong to a chat. */
async function memberIds(chatId) {
  const r = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
  return r.rows.map((x) => x.user_id);
}

/** True if the user has at least one live socket (app open / connected). */
function isOnline(io, userId) {
  const room = io.sockets.adapter.rooms.get(`user:${userId}`);
  return !!room && room.size > 0;
}

/**
 * Emits to every member's personal room (each user joins `user:<id>` on
 * connect). Unlike emitting to a `chat:<id>` room this reaches members who
 * haven't opened that chat yet, so their chat list updates live too.
 */
async function emitToMembers(io, chatId, event, payload, { except } = {}) {
  const ids = await memberIds(chatId);
  ids.filter((id) => id !== except).forEach((id) => io.to(`user:${id}`).emit(event, payload));
}

/** Distinct users who share at least one chat with userId. */
async function contactIds(userId) {
  const r = await pool.query(
    `SELECT DISTINCT b.user_id
       FROM chat_members a JOIN chat_members b ON a.chat_id = b.chat_id
      WHERE a.user_id = $1 AND b.user_id != $1`,
    [userId],
  );
  return r.rows.map((x) => x.user_id);
}

/** True if EITHER user has blocked the other — blocking is always mutual in effect. */
async function isBlocked(userIdA, userIdB) {
  const r = await pool.query(
    `SELECT 1 FROM blocked_users
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [userIdA, userIdB],
  );
  return r.rows.length > 0;
}

/** The "Son Görülme & Çevrimiçi Durumu Göster" toggle — real, enforced server-side. */
async function getShowLastSeen(userId) {
  const r = await pool.query('SELECT show_last_seen FROM user_settings WHERE user_id = $1', [userId]);
  return r.rows[0]?.show_last_seen ?? true;
}

/** For a DIRECT chat, true if either participant has blocked the other. */
async function isChatBlocked(chatId, userId) {
  const r = await pool.query(
    `SELECT cm.user_id FROM chat_members cm
       JOIN chats c ON c.id = cm.chat_id
      WHERE cm.chat_id = $1 AND c.kind = 'DIRECT' AND cm.user_id != $2`,
    [chatId, userId],
  );
  if (r.rows.length === 0) return false; // GROUP chats are never blocked
  return isBlocked(userId, r.rows[0].user_id);
}

const MESSAGE_SELECT = `
  SELECT m.id, m.chat_id, m.sender_id, m.type, m.text, m.created_at,
         m.reply_to_id, m.edited_at, m.forwarded,
         (m.media_data IS NOT NULL) AS has_media, m.media_mime, m.media_filename,
         octet_length(m.media_data) AS media_size,
         EXISTS (
           SELECT 1 FROM chat_members cm
            JOIN user_settings cs ON cs.user_id = cm.user_id
            WHERE cm.chat_id = m.chat_id AND cm.user_id != m.sender_id
              AND cm.last_read_at >= m.created_at
              -- Real privacy enforcement: a reader who disabled read
              -- receipts never shows up as having read anyone's messages.
              AND cs.read_receipts_enabled = true
         ) AS read_by_peer,
         u.handle AS sender_handle, u.display_name AS sender_display_name,
         u.avatar_url AS sender_avatar_url
    FROM messages m
    JOIN users u ON u.id = m.sender_id`;

async function selectEnrichedMessage(messageId) {
  const r = await pool.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [messageId]);
  return r.rows[0];
}

/** Üyenin sohbetteki rolü ('ADMIN' | 'MEMBER'); üye değilse null. */
async function memberRole(chatId, userId) {
  const r = await pool.query('SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  return r.rows.length ? r.rows[0].role : null;
}

/** replyToId aynı sohbetteki var olan bir mesaja işaret ediyor mu? (yoksa/boşsa true: yanıt isteğe bağlı) */
async function validReplyTarget(chatId, replyToId) {
  if (!replyToId) return true;
  const r = await pool.query('SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2', [replyToId, chatId]);
  return r.rows.length > 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Metin mesajını ekler (REST ve soket yolu ortak kullanır). Üyelik/engel kontrolü çağıranda yapılır.
 * Dönüş: { message } ya da { error }.
 */
async function insertTextMessage({ chatId, senderId, text, replyToId = null, forwarded = false }) {
  if (replyToId && !UUID_RE.test(String(replyToId))) return { error: 'invalid reply' };
  if (!(await validReplyTarget(chatId, replyToId))) return { error: 'invalid reply' };
  const inserted = await pool.query(
    `INSERT INTO messages (chat_id, sender_id, type, text, reply_to_id, forwarded)
     VALUES ($1, $2, 'TEXT', $3, $4, $5) RETURNING id`,
    [chatId, senderId, text, replyToId || null, forwarded === true],
  );
  return { message: await selectEnrichedMessage(inserted.rows[0].id) };
}

module.exports = {
  memberIds, isOnline, emitToMembers, contactIds, isBlocked, isChatBlocked, getShowLastSeen,
  MESSAGE_SELECT, selectEnrichedMessage, memberRole, validReplyTarget, insertTextMessage, UUID_RE,
};
