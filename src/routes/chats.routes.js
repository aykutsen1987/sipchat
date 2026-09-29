const express = require('express');
const multer = require('multer');
const { body, param, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notifyOtherMembers } = require('../sockets');
const {
  isOnline, emitToMembers, MESSAGE_SELECT, selectEnrichedMessage,
} = require('../realtime');

const router = express.Router();
router.use(requireAuth);

// 8 MB, held in memory just long enough to insert into Postgres as bytea.
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MEDIA_BYTES } });

const invalid = (req) => !validationResult(req).isEmpty();

async function assertMember(chatId, userId) {
  const r = await pool.query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  return r.rows.length > 0;
}

// GET /api/chats — my chats. DIRECT chats are titled with the OTHER person's
// name (per viewer), and carry unread count + presence.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.kind,
              CASE WHEN c.kind = 'DIRECT' THEN COALESCE(peer.display_name, c.title) ELSE c.title END AS title,
              peer.id AS peer_user_id,
              m.text AS last_message_text, m.type AS last_message_type, m.created_at AS last_message_at,
              (SELECT COUNT(*) FROM messages um
                WHERE um.chat_id = c.id AND um.sender_id != $1 AND um.created_at > cm.last_read_at)::int AS unread_count,
              (SELECT COUNT(*) FROM chat_members x WHERE x.chat_id = c.id)::int AS member_count
         FROM chats c
         JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
         LEFT JOIN LATERAL (
              SELECT u.id, u.display_name FROM chat_members pm JOIN users u ON u.id = pm.user_id
               WHERE pm.chat_id = c.id AND pm.user_id != $1 AND c.kind = 'DIRECT' LIMIT 1
         ) peer ON true
         LEFT JOIN LATERAL (
              SELECT text, type, created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1
         ) m ON true
        ORDER BY COALESCE(m.created_at, c.created_at) DESC`,
      [req.user.id],
    );

    const io = req.app.get('io');
    const chats = result.rows.map((row) => ({
      ...row,
      peer_online: row.peer_user_id ? isOnline(io, row.peer_user_id) : false,
    }));
    res.json({ chats });
  } catch (err) {
    console.error('get chats error', err);
    res.status(500).json({ error: 'Sohbetler getirilemedi.' });
  }
});

// POST /api/chats — start a 1:1 chat ({type:"DIRECT", userId}) or create a
// group ({type:"GROUP", title, memberIds:[...]}). Starting a DIRECT chat with
// someone you already have one with just returns the existing chat.
router.post(
  '/',
  [
    body('type').isIn(['DIRECT', 'GROUP']),
    body('userId').optional().isUUID(),
    body('title').optional().trim().isLength({ min: 1, max: 60 }),
    body('memberIds').optional().isArray({ min: 1, max: 50 }),
    body('memberIds.*').optional().isUUID(),
  ],
  async (req, res) => {
    if (invalid(req)) return res.status(400).json({ error: 'Geçersiz istek.' });

    const me = req.user.id;
    const { type } = req.body;
    const client = await pool.connect();
    try {
      let others;
      let title;
      if (type === 'DIRECT') {
        if (!req.body.userId || req.body.userId === me) {
          return res.status(400).json({ error: 'Geçerli bir kullanıcı seçin.' });
        }
        others = [req.body.userId];
        const existing = await client.query(
          `SELECT c.id FROM chats c
             JOIN chat_members a ON a.chat_id = c.id AND a.user_id = $1
             JOIN chat_members b ON b.chat_id = c.id AND b.user_id = $2
            WHERE c.kind = 'DIRECT' LIMIT 1`,
          [me, others[0]],
        );
        if (existing.rows.length > 0) return res.json({ chatId: existing.rows[0].id, created: false });
        title = 'Sohbet'; // displayed title is derived per-viewer in GET /
      } else {
        if (!req.body.title || !req.body.memberIds) {
          return res.status(400).json({ error: 'Grup için başlık ve üyeler gerekli.' });
        }
        others = [...new Set(req.body.memberIds)].filter((id) => id !== me);
        if (others.length === 0) return res.status(400).json({ error: 'En az bir başka üye seçin.' });
        title = req.body.title;
      }

      const found = await client.query('SELECT id FROM users WHERE id = ANY($1)', [others]);
      if (found.rows.length !== others.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

      await client.query('BEGIN');
      const chat = await client.query('INSERT INTO chats (kind, title) VALUES ($1, $2) RETURNING id', [type, title]);
      const chatId = chat.rows[0].id;
      await client.query(
        'INSERT INTO chat_members (chat_id, user_id) SELECT $1, unnest($2::uuid[])',
        [chatId, [me, ...others]],
      );
      await client.query('COMMIT');

      const io = req.app.get('io');
      others.forEach((id) => io?.to(`user:${id}`).emit('chat:created', { chatId }));
      res.status(201).json({ chatId, created: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('create chat error', err);
      res.status(500).json({ error: 'Sohbet oluşturulamadı.' });
    } finally {
      client.release();
    }
  },
);

// GET /api/chats/:chatId/messages — oldest→newest.
router.get('/:chatId/messages', [param('chatId').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz chatId.' });
  const { chatId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    if (!(await assertMember(chatId, req.user.id))) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });
    const result = await pool.query(
      `${MESSAGE_SELECT} WHERE m.chat_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
      [chatId, limit],
    );
    res.json({ messages: result.rows.reverse() });
  } catch (err) {
    console.error('get messages error', err);
    res.status(500).json({ error: 'Mesajlar getirilemedi.' });
  }
});

// POST /api/chats/:chatId/messages — REST send (used when the socket is down).
router.post(
  '/:chatId/messages',
  [param('chatId').isUUID(), body('text').isString().isLength({ min: 1, max: 8000 })],
  async (req, res) => {
    if (invalid(req)) return res.status(400).json({ error: 'Geçersiz istek.' });
    const { chatId } = req.params;
    try {
      if (!(await assertMember(chatId, req.user.id))) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });
      const inserted = await pool.query(
        `INSERT INTO messages (chat_id, sender_id, type, text) VALUES ($1, $2, 'TEXT', $3) RETURNING id`,
        [chatId, req.user.id, req.body.text],
      );
      const message = await selectEnrichedMessage(inserted.rows[0].id);
      const io = req.app.get('io');
      await emitToMembers(io, chatId, 'message:new', message);
      notifyOtherMembers(io, chatId, req.user.id, message);
      res.status(201).json({ message });
    } catch (err) {
      console.error('post message error', err);
      res.status(500).json({ error: 'Mesaj gönderilemedi.' });
    }
  },
);

// POST /api/chats/:chatId/media — multipart upload. Type is derived from the
// MIME type: image/* → IMAGE, audio/* → VOICE, anything else → FILE. For
// VOICE the optional text field "duration" (e.g. "0:12") is stored in `text`.
router.post('/:chatId/media', [param('chatId').isUUID()], upload.single('file'), async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz chatId.' });
  if (!req.file) return res.status(400).json({ error: 'Dosya eksik (multipart alan adı: "file").' });
  const { chatId } = req.params;
  try {
    if (!(await assertMember(chatId, req.user.id))) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });

    const mime = req.file.mimetype || 'application/octet-stream';
    const type = mime.startsWith('image/') ? 'IMAGE' : mime.startsWith('audio/') ? 'VOICE' : 'FILE';
    const duration = type === 'VOICE' && typeof req.body.duration === 'string' ? req.body.duration.slice(0, 10) : null;

    const inserted = await pool.query(
      `INSERT INTO messages (chat_id, sender_id, type, text, media_data, media_mime, media_filename)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [chatId, req.user.id, type, duration, req.file.buffer, mime, req.file.originalname],
    );
    const message = await selectEnrichedMessage(inserted.rows[0].id);
    const io = req.app.get('io');
    await emitToMembers(io, chatId, 'message:new', message);
    notifyOtherMembers(io, chatId, req.user.id, message);
    res.status(201).json({ message });
  } catch (err) {
    console.error('post media error', err);
    res.status(500).json({ error: 'Medya gönderilemedi.' });
  }
});

// POST /api/chats/:chatId/read — I've read everything up to now.
router.post('/:chatId/read', [param('chatId').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz chatId.' });
  const { chatId } = req.params;
  try {
    const r = await pool.query(
      'UPDATE chat_members SET last_read_at = now() WHERE chat_id = $1 AND user_id = $2',
      [chatId, req.user.id],
    );
    if (r.rowCount === 0) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });
    await emitToMembers(req.app.get('io'), chatId, 'chat:read', { chatId, userId: req.user.id }, { except: req.user.id });
    res.status(204).send();
  } catch (err) {
    console.error('read error', err);
    res.status(500).json({ error: 'İşlem başarısız.' });
  }
});

// DELETE /api/chats/:chatId/messages/:messageId — delete my own message for everyone.
router.delete('/:chatId/messages/:messageId', [param('chatId').isUUID(), param('messageId').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz istek.' });
  const { chatId, messageId } = req.params;
  try {
    const r = await pool.query(
      'DELETE FROM messages WHERE id = $1 AND chat_id = $2 AND sender_id = $3',
      [messageId, chatId, req.user.id],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Mesaj bulunamadı veya size ait değil.' });
    await emitToMembers(req.app.get('io'), chatId, 'message:deleted', { chatId, messageId });
    res.status(204).send();
  } catch (err) {
    console.error('delete message error', err);
    res.status(500).json({ error: 'Mesaj silinemedi.' });
  }
});

// GET /api/chats/:chatId/peer-key — the other member's E2E public key (DIRECT only).
router.get('/:chatId/peer-key', [param('chatId').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz chatId.' });
  try {
    const chat = await pool.query('SELECT kind FROM chats WHERE id = $1', [req.params.chatId]);
    if (chat.rows.length === 0) return res.status(404).json({ error: 'Sohbet bulunamadı.' });
    if (chat.rows[0].kind !== 'DIRECT') return res.status(400).json({ error: 'peer-key yalnızca DIRECT sohbetler için geçerlidir.' });
    if (!(await assertMember(req.params.chatId, req.user.id))) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });

    const peer = await pool.query(
      `SELECT uk.public_key, cm.user_id FROM chat_members cm
         JOIN user_keys uk ON uk.user_id = cm.user_id
        WHERE cm.chat_id = $1 AND cm.user_id != $2 LIMIT 1`,
      [req.params.chatId, req.user.id],
    );
    if (peer.rows.length === 0) return res.status(404).json({ error: 'Karşı tarafın henüz yayınlanmış bir anahtarı yok.' });
    res.json({ userId: peer.rows[0].user_id, publicKey: peer.rows[0].public_key });
  } catch (err) {
    console.error('get peer-key error', err);
    res.status(500).json({ error: 'Anahtar getirilemedi.' });
  }
});

module.exports = router;
