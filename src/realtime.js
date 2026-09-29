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

const MESSAGE_SELECT = `
  SELECT m.id, m.chat_id, m.sender_id, m.type, m.text, m.created_at,
         (m.media_data IS NOT NULL) AS has_media, m.media_mime, m.media_filename,
         octet_length(m.media_data) AS media_size,
         EXISTS (
           SELECT 1 FROM chat_members cm
            WHERE cm.chat_id = m.chat_id AND cm.user_id != m.sender_id
              AND cm.last_read_at >= m.created_at
         ) AS read_by_peer,
         u.handle AS sender_handle, u.display_name AS sender_display_name,
         u.avatar_url AS sender_avatar_url
    FROM messages m
    JOIN users u ON u.id = m.sender_id`;

async function selectEnrichedMessage(messageId) {
  const r = await pool.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [messageId]);
  return r.rows[0];
}

module.exports = { memberIds, isOnline, emitToMembers, contactIds, MESSAGE_SELECT, selectEnrichedMessage };
