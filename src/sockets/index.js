const { verifyToken } = require('../utils/jwt');
const { pool } = require('../db');
const { sendPushToUser } = require('../push');
const {
  memberIds, isOnline, emitToMembers, contactIds, selectEnrichedMessage,
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

    // Kept for older clients; live delivery now goes through the personal
    // `user:<id>` room, so joining chat rooms is no longer required.
    socket.on('chat:join', () => {});
    socket.on('chat:leave', () => {});

    socket.on('message:send', async (payload, ack) => {
      try {
        const { chatId, text } = payload || {};
        if (!chatId || !text || typeof text !== 'string' || text.length > 8000) {
          return ack?.({ ok: false, error: 'invalid payload' });
        }
        if (!(await assertMember(chatId, socket.userId))) return ack?.({ ok: false, error: 'forbidden' });

        const inserted = await pool.query(
          `INSERT INTO messages (chat_id, sender_id, type, text) VALUES ($1, $2, 'TEXT', $3) RETURNING id`,
          [chatId, socket.userId, text],
        );
        const message = await selectEnrichedMessage(inserted.rows[0].id);
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
      io.to(`user:${targetUserId}`).emit('call:invite', {
        chatId, fromUserId: socket.userId, fromHandle: socket.userHandle, callType, sdpOffer,
      });
    });
    socket.on('call:answer', ({ targetUserId, sdpAnswer }) => {
      io.to(`user:${targetUserId}`).emit('call:answer', { fromUserId: socket.userId, sdpAnswer });
    });
    socket.on('call:ice-candidate', ({ targetUserId, candidate }) => {
      io.to(`user:${targetUserId}`).emit('call:ice-candidate', { fromUserId: socket.userId, candidate });
    });
    socket.on('call:decline', ({ targetUserId }) => {
      io.to(`user:${targetUserId}`).emit('call:decline', { fromUserId: socket.userId });
    });
    socket.on('call:end', ({ targetUserId }) => {
      io.to(`user:${targetUserId}`).emit('call:end', { fromUserId: socket.userId });
    });

    socket.on('disconnect', () => {
      console.log(`socket disconnected: ${socket.userHandle} (${socket.id})`);
      if (!isOnline(io, socket.userId)) broadcastPresence(io, socket.userId, false);
    });
  });
}

async function broadcastPresence(io, userId, online) {
  try {
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
    const body = message.type === 'TEXT'
      // E2E payloads are ciphertext the server can't read — don't leak them into a notification.
      ? (String(message.text || '').startsWith('sipchat-e2e-v1:') ? 'Yeni şifreli mesaj' : String(message.text || '').slice(0, 120))
      : message.type === 'VOICE' ? 'Sesli mesaj gönderdi'
        : message.type === 'IMAGE' ? 'Fotoğraf gönderdi' : 'Dosya gönderdi';

    const ids = (await memberIds(chatId)).filter((id) => id !== senderId && !isOnline(io, id));
    await Promise.all(ids.map((id) => sendPushToUser(id, { title: senderName, body })));
  } catch (err) {
    console.error('notifyOtherMembers error (non-fatal)', err);
  }
}

module.exports = { attachSockets, notifyOtherMembers };
