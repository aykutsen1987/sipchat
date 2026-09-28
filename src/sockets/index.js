const { verifyToken } = require('../utils/jwt');
const { pool } = require('../db');
const { sendPushToUser } = require('../push');

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

    // A personal room lets us reach "this user, on any device/tab" without
    // knowing which chat rooms they've joined — used for call signaling and
    // could be reused later for direct read-receipt/typing pushes.
    socket.join(`user:${socket.userId}`);

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

        const message = await selectEnrichedMessage(inserted.rows[0].id);
        io.to(`chat:${chatId}`).emit('message:new', message);
        ack?.({ ok: true, message });

        notifyOtherMembers(io, chatId, socket.userId, message);
      } catch (err) {
        console.error('message:send error', err);
        ack?.({ ok: false, error: 'server error' });
      }
    });

    // --- WebRTC call signaling ------------------------------------------
    // This server only relays SDP offers/answers and ICE candidates between
    // the two participants' personal rooms — it never inspects or stores
    // call content. See Android's CallViewModel/WebRtcClient for the peer
    // connection side. A STUN-only setup (no TURN) is used by default; see
    // sipchat-backend/README.md's "Sesli/Görüntülü Arama" section for why
    // that's fine for testing but not for production NAT traversal.

    socket.on('call:invite', async ({ chatId, targetUserId, callType, sdpOffer }) => {
      const isMember = await assertMember(chatId, socket.userId);
      if (!isMember) return;
      io.to(`user:${targetUserId}`).emit('call:invite', {
        chatId,
        fromUserId: socket.userId,
        fromHandle: socket.userHandle,
        callType, // "audio" | "video"
        sdpOffer,
      });
    });

    socket.on('call:answer', ({ targetUserId, sdpAnswer }) => {
      io.to(`user:${targetUserId}`).emit('call:answer', {
        fromUserId: socket.userId,
        sdpAnswer,
      });
    });

    socket.on('call:ice-candidate', ({ targetUserId, candidate }) => {
      io.to(`user:${targetUserId}`).emit('call:ice-candidate', {
        fromUserId: socket.userId,
        candidate,
      });
    });

    socket.on('call:decline', ({ targetUserId }) => {
      io.to(`user:${targetUserId}`).emit('call:decline', { fromUserId: socket.userId });
    });

    socket.on('call:end', ({ targetUserId }) => {
      io.to(`user:${targetUserId}`).emit('call:end', { fromUserId: socket.userId });
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

async function selectEnrichedMessage(messageId) {
  const result = await pool.query(
    `SELECT m.id, m.chat_id, m.sender_id, m.type, m.text, m.created_at,
            (m.media_data IS NOT NULL) AS has_media, m.media_mime,
            u.handle AS sender_handle, u.display_name AS sender_display_name,
            u.avatar_url AS sender_avatar_url
       FROM messages m
       JOIN users u ON u.id = m.sender_id
      WHERE m.id = $1`,
    [messageId],
  );
  return result.rows[0];
}

/** Fire-and-forget push to every other member of the chat besides the sender. */
async function notifyOtherMembers(io, chatId, senderId, message) {
  try {
    const result = await pool.query(
      `SELECT cm.user_id, c.title AS chat_title, u.display_name AS sender_name
         FROM chat_members cm
         JOIN chats c ON c.id = cm.chat_id
         JOIN users u ON u.id = $2
        WHERE cm.chat_id = $1 AND cm.user_id != $2`,
      [chatId, senderId],
    );

    const bodyText = message.type === 'TEXT'
      ? (message.text || '').slice(0, 120)
      : 'Bir medya gönderdi';

    await Promise.all(
      result.rows.map((row) => sendPushToUser(row.user_id, {
        title: row.sender_name,
        body: bodyText,
      })),
    );
  } catch (err) {
    console.error('notifyOtherMembers error (non-fatal)', err);
  }
}

module.exports = { attachSockets, selectEnrichedMessage, notifyOtherMembers };
