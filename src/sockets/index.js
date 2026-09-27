const { verifyToken } = require('../utils/jwt');
const { pool } = require('../db');

/**
 * Wires Socket.IO onto an existing http.Server + Express app.
 * Every connection must present a valid JWT (same one issued by
 * /api/auth/login) — anonymous sockets are rejected before any event
 * handler runs.
 */
function attachSockets(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('unauthorized'));

    try {
      const payload = verifyToken(token);
      socket.userId = payload.sub;
      socket.userHandle = payload.handle;
      return next();
    } catch (err) {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`socket connected: ${socket.userHandle} (${socket.id})`);

    socket.on('chat:join', async (chatId) => {
      const isMember = await assertMember(chatId, socket.userId);
      if (!isMember) return; // silently ignore — do not leak chat existence
      socket.join(`chat:${chatId}`);
    });

    socket.on('chat:leave', (chatId) => {
      socket.leave(`chat:${chatId}`);
    });

    socket.on('message:send', async (payload, ack) => {
      try {
        const { chatId, text } = payload || {};
        if (!chatId || !text || typeof text !== 'string' || text.length > 4000) {
          return ack?.({ ok: false, error: 'invalid payload' });
        }

        const isMember = await assertMember(chatId, socket.userId);
        if (!isMember) return ack?.({ ok: false, error: 'forbidden' });

        const inserted = await pool.query(
          `INSERT INTO messages (chat_id, sender_id, type, text)
           VALUES ($1, $2, 'TEXT', $3)
           RETURNING id`,
          [chatId, socket.userId, text],
        );

        const result = await pool.query(
          `SELECT m.id, m.chat_id, m.sender_id, m.type, m.text, m.created_at,
                  u.handle AS sender_handle, u.display_name AS sender_display_name,
                  u.avatar_url AS sender_avatar_url
             FROM messages m
             JOIN users u ON u.id = m.sender_id
            WHERE m.id = $1`,
          [inserted.rows[0].id],
        );
        const message = result.rows[0];

        io.to(`chat:${chatId}`).emit('message:new', message);
        ack?.({ ok: true, message });
      } catch (err) {
        console.error('message:send error', err);
        ack?.({ ok: false, error: 'server error' });
      }
    });

    socket.on('disconnect', () => {
      console.log(`socket disconnected: ${socket.userHandle} (${socket.id})`);
    });
  });
}

async function assertMember(chatId, userId) {
  const result = await pool.query(
    'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
    [chatId, userId],
  );
  return result.rows.length > 0;
}

module.exports = { attachSockets };
