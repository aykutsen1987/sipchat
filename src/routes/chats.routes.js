const express = require('express');
const multer = require('multer');
const { body, param, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { selectEnrichedMessage, notifyOtherMembers } = require('../sockets');

const router = express.Router();
router.use(requireAuth); // every route below requires a valid Bearer token

// 8 MB cap, kept in memory only long enough to insert into Postgres as
// bytea — see backend README's "Medya Gönderimi" section for why this is
// fine on Render's free Postgres for a demo/MVP but not for real scale.
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MEDIA_BYTES } });

// GET /api/chats — the caller's chat list, most recent message first.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.kind, c.title,
              m.text AS last_message_text, m.type AS last_message_type,
              m.created_at AS last_message_at,
              (SELECT user_id FROM chat_members
                WHERE chat_id = c.id AND user_id != $1 LIMIT 1) AS peer_user_id
         FROM chats c
         JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
         LEFT JOIN LATERAL (
              SELECT text, type, created_at FROM messages
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
        `SELECT m.id, m.chat_id, m.sender_id, m.type, m.text, m.created_at,
                (m.media_data IS NOT NULL) AS has_media, m.media_mime,
                u.handle AS sender_handle, u.display_name AS sender_display_name,
                u.avatar_url AS sender_avatar_url
           FROM messages m
           JOIN users u ON u.id = m.sender_id
          WHERE m.chat_id = $1
          ORDER BY m.created_at DESC
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

// POST /api/chats/:chatId/messages — REST fallback for sending a text
// message (the primary path is the Socket.IO "message:send" event; this
// exists so sending still works if the socket is momentarily disconnected).
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

      const inserted = await pool.query(
        `INSERT INTO messages (chat_id, sender_id, type, text)
         VALUES ($1, $2, 'TEXT', $3)
         RETURNING id`,
        [chatId, req.user.id, text],
      );

      const message = await selectEnrichedMessage(inserted.rows[0].id);
      req.app.get('io')?.to(`chat:${chatId}`).emit('message:new', message);
      notifyOtherMembers(req.app.get('io'), chatId, req.user.id, message);

      res.status(201).json({ message });
    } catch (err) {
      console.error('post message error', err);
      res.status(500).json({ error: 'Mesaj gönderilemedi.' });
    }
  },
);

// POST /api/chats/:chatId/media — multipart image/file upload. Stored as
// bytea directly in Postgres (see MAX_MEDIA_BYTES above); served back out
// via GET /api/media/:messageId (mounted in index.js).
router.post(
  '/:chatId/media',
  [param('chatId').isUUID()],
  upload.single('file'),
  async (req, res) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ error: 'Geçersiz chatId.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Dosya eksik (multipart alan adı: "file").' });
    }

    const { chatId } = req.params;

    try {
      const membership = await assertMember(chatId, req.user.id);
      if (!membership) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });

      const messageType = req.file.mimetype.startsWith('image/') ? 'IMAGE' : 'FILE';

      const inserted = await pool.query(
        `INSERT INTO messages (chat_id, sender_id, type, media_data, media_mime, media_filename)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [chatId, req.user.id, messageType, req.file.buffer, req.file.mimetype, req.file.originalname],
      );

      const message = await selectEnrichedMessage(inserted.rows[0].id);
      req.app.get('io')?.to(`chat:${chatId}`).emit('message:new', message);
      notifyOtherMembers(req.app.get('io'), chatId, req.user.id, message);

      res.status(201).json({ message });
    } catch (err) {
      console.error('post media error', err);
      res.status(500).json({ error: 'Medya gönderilemedi.' });
    }
  },
);

// GET /api/chats/:chatId/peer-key — for a DIRECT chat, returns the OTHER
// member's E2E public key so the caller can encrypt a message to them.
// Deliberately scoped to DIRECT chats: group E2E needs per-member key
// wrapping (Signal-style sender keys), which is out of scope for now — see
// README's "Uçtan Uca Şifreleme" limitations.
router.get(
  '/:chatId/peer-key',
  [param('chatId').isUUID()],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ error: 'Geçersiz chatId.' });
    }
    try {
      const chat = await pool.query('SELECT kind FROM chats WHERE id = $1', [req.params.chatId]);
      if (chat.rows.length === 0) return res.status(404).json({ error: 'Sohbet bulunamadı.' });
      if (chat.rows[0].kind !== 'DIRECT') {
        return res.status(400).json({ error: 'peer-key yalnızca DIRECT sohbetler için geçerlidir.' });
      }

      const membership = await assertMember(req.params.chatId, req.user.id);
      if (!membership) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });

      const peer = await pool.query(
        `SELECT uk.public_key, cm.user_id
           FROM chat_members cm
           JOIN user_keys uk ON uk.user_id = cm.user_id
          WHERE cm.chat_id = $1 AND cm.user_id != $2
          LIMIT 1`,
        [req.params.chatId, req.user.id],
      );
      if (peer.rows.length === 0) {
        return res.status(404).json({ error: 'Karşı tarafın henüz yayınlanmış bir anahtarı yok.' });
      }

      res.json({ userId: peer.rows[0].user_id, publicKey: peer.rows[0].public_key });
    } catch (err) {
      console.error('get peer-key error', err);
      res.status(500).json({ error: 'Anahtar getirilemedi.' });
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
