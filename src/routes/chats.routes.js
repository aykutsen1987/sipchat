const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth); // every route below requires a valid Bearer token

// GET /api/chats — the caller's chat list, most recent message first.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.kind, c.title,
              m.text AS last_message_text, m.created_at AS last_message_at
         FROM chats c
         JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
         LEFT JOIN LATERAL (
              SELECT text, created_at FROM messages
               WHERE chat_id = c.id
               ORDER BY created_at DESC LIMIT 1
         ) m ON true
        ORDER BY m.created_at DESC NULLS LAST`,
      [req.user.id],
    );
    res.json({ chats: result.rows });
  } catch (err) {
    console.error('get chats error', err);
    res.status(500).json({ error: 'Sohbetler getirilemedi.' });
  }
});

// GET /api/chats/:chatId/messages — paginated, oldest→newest for easy rendering.
router.get(
  '/:chatId/messages',
  [param('chatId').isUUID()],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ error: 'Geçersiz chatId.' });
    }

    const { chatId } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    try {
      const membership = await assertMember(chatId, req.user.id);
      if (!membership) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });

      const result = await pool.query(
        `SELECT id, chat_id, sender_id, type, text, created_at
           FROM messages
          WHERE chat_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [chatId, limit],
      );
      res.json({ messages: result.rows.reverse() });
    } catch (err) {
      console.error('get messages error', err);
      res.status(500).json({ error: 'Mesajlar getirilemedi.' });
    }
  },
);

// POST /api/chats/:chatId/messages — REST fallback for sending a message
// (the primary path is the Socket.IO "message:send" event; this exists so
// sending still works if the socket is momentarily disconnected).
router.post(
  '/:chatId/messages',
  [
    param('chatId').isUUID(),
    body('text').trim().isLength({ min: 1, max: 4000 }),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ error: 'Geçersiz istek.' });
    }

    const { chatId } = req.params;
    const { text } = req.body;

    try {
      const membership = await assertMember(chatId, req.user.id);
      if (!membership) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });

      const result = await pool.query(
        `INSERT INTO messages (chat_id, sender_id, type, text)
         VALUES ($1, $2, 'TEXT', $3)
         RETURNING id, chat_id, sender_id, type, text, created_at`,
        [chatId, req.user.id, text],
      );

      const message = result.rows[0];

      // Also push it to anyone connected in real time right now.
      req.app.get('io')?.to(`chat:${chatId}`).emit('message:new', message);

      res.status(201).json({ message });
    } catch (err) {
      console.error('post message error', err);
      res.status(500).json({ error: 'Mesaj gönderilemedi.' });
    }
  },
);

async function assertMember(chatId, userId) {
  const result = await pool.query(
    'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
    [chatId, userId],
  );
  return result.rows.length > 0;
}

module.exports = router;
