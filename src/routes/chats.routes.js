const express = require('express');
const multer = require('multer');
const { body, param, query, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notifyOtherMembers } = require('../sockets');
const {
  isOnline, emitToMembers, isBlocked, isChatBlocked, MESSAGE_SELECT, selectEnrichedMessage,
  memberRole, validReplyTarget, insertTextMessage, UUID_RE,
} = require('../realtime');

const router = express.Router();
router.use(requireAuth);

// 20 MB cap (kept in memory only long enough to insert into Postgres as
// bytea) — enough for a short video clip. See README.md's "Medya
// Gönderimi" section for why this is fine on Render's free Postgres for a
// demo/MVP but not for real scale.
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MEDIA_BYTES } });

const invalid = (req) => !validationResult(req).isEmpty();

// Mesajı yazdıktan sonra bu süre içinde düzenlenebilir.
const EDIT_WINDOW_MS = 15 * 60 * 1000;

// Grup fotoğrafı: istemci küçültür; sunucu tarafında 2 MB üst sınır + gerçek tür kontrolü.
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES } });

function sniffImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** Grup mı, yönetici miyim? Dönüş: { ok: true } ya da { status, error }. */
async function requireGroupAdmin(chatId, userId) {
  const chat = await pool.query('SELECT kind FROM chats WHERE id = $1', [chatId]);
  if (chat.rows.length === 0) return { status: 404, error: 'Sohbet bulunamadı.' };
  if (chat.rows[0].kind !== 'GROUP') return { status: 400, error: 'Bu işlem yalnızca gruplar için geçerli.' };
  const role = await memberRole(chatId, userId);
  if (!role) return { status: 403, error: 'Bu sohbete erişiminiz yok.' };
  if (role !== 'ADMIN') return { status: 403, error: 'Bu işlem için grup yöneticisi olmalısınız.' };
  return { ok: true };
}

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
              COALESCE(peer_settings.show_last_seen, true) AS peer_show_last_seen,
              c.disappear_seconds, c.photo_url, cm.role AS my_role,
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
         LEFT JOIN user_settings peer_settings ON peer_settings.user_id = peer.id
         LEFT JOIN LATERAL (
              SELECT text, type, created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1
         ) m ON true
        ORDER BY COALESCE(m.created_at, c.created_at) DESC`,
      [req.user.id],
    );

    const io = req.app.get('io');
    const chats = result.rows.map((row) => ({
      ...row,
      // Real enforcement: if the peer turned last-seen/online off, they
      // always look offline here — same rule the socket layer applies.
      peer_online: row.peer_user_id && row.peer_show_last_seen ? isOnline(io, row.peer_user_id) : false,
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
        if (await isBlocked(me, req.body.userId)) {
          return res.status(403).json({ error: 'Bu kullanıcıyla sohbet başlatılamıyor.' });
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

      // "Kaybolan Mesajlar — Varsayılan" in Settings: applied to every chat I
      // start from here on. Existing chats only change when the user opts in
      // ("applyToExistingChats" in PATCH /api/settings, see settings.routes.js).
      const defaults = await client.query(
        'SELECT disappearing_default_seconds FROM user_settings WHERE user_id = $1',
        [me],
      );
      const disappearSeconds = defaults.rows[0]?.disappearing_default_seconds ?? null;

      await client.query('BEGIN');
      const chat = await client.query(
        'INSERT INTO chats (kind, title, disappear_seconds) VALUES ($1, $2, $3) RETURNING id',
        [type, title, disappearSeconds],
      );
      const chatId = chat.rows[0].id;
      // Grubu kuran kişi yönetici olur (birebir sohbette rol anlamsızdır).
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role)
         SELECT $1, u, CASE WHEN u = $3::uuid AND $4 = 'GROUP' THEN 'ADMIN' ELSE 'MEMBER' END FROM unnest($2::uuid[]) AS u`,
        [chatId, [me, ...others], me, type],
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

// GET /api/chats/:chatId/messages?limit=50&before=<ISO tarih> — oldest→newest.
// "before" verilirse yalnızca o andan ESKİ mesajlar gelir (yukarı kaydırınca eski mesajları yüklemek için);
// hasMore: daha eski mesaj var mı. (Milisaniye sınırında tekrar gelen mesaj istemcide id ile birleşir.)
router.get(
  '/:chatId/messages',
  [param('chatId').isUUID(), query('before').optional().isISO8601(), query('limit').optional().isInt({ min: 1, max: 200 })],
  async (req, res) => {
    if (invalid(req)) return res.status(400).json({ error: 'Geçersiz istek.' });
    const { chatId } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const before = req.query.before || null;
    try {
      if (!(await assertMember(chatId, req.user.id))) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });
      const params = [chatId, limit + 1];
      let beforeSql = '';
      if (before) {
        params.push(before);
        beforeSql = "AND m.created_at < ($3::timestamptz + interval '1 millisecond')";
      }
      const result = await pool.query(
        `${MESSAGE_SELECT} WHERE m.chat_id = $1 ${beforeSql} ORDER BY m.created_at DESC LIMIT $2`,
        params,
      );
      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
      res.json({ messages: rows.reverse(), hasMore });
    } catch (err) {
      console.error('get messages error', err);
      res.status(500).json({ error: 'Mesajlar getirilemedi.' });
    }
  },
);

// POST /api/chats/:chatId/messages — REST send (used when the socket is down).
// Opsiyonel: replyToId (aynı sohbetteki bir mesaja yanıt), forwarded (iletilmiş mesaj işareti).
router.post(
  '/:chatId/messages',
  [
    param('chatId').isUUID(),
    body('text').isString().isLength({ min: 1, max: 8000 }),
    body('replyToId').optional({ nullable: true }).isUUID(),
    body('forwarded').optional().isBoolean(),
  ],
  async (req, res) => {
    if (invalid(req)) return res.status(400).json({ error: 'Geçersiz istek.' });
    const { chatId } = req.params;
    try {
      if (!(await assertMember(chatId, req.user.id))) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });
      if (await isChatBlocked(chatId, req.user.id)) return res.status(403).json({ error: 'Bu kişiyle mesajlaşamazsınız.' });
      const result = await insertTextMessage({
        chatId, senderId: req.user.id, text: req.body.text, replyToId: req.body.replyToId || null, forwarded: req.body.forwarded === true,
      });
      if (result.error) return res.status(400).json({ error: 'Yanıtlanan mesaj bulunamadı.' });
      const { message } = result;
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

// PATCH /api/chats/:chatId/messages/:messageId {text} — kendi METİN mesajımı düzenle (15 dk içinde).
// Birebir sohbetlerde metin uçtan uca şifrelidir: istemci yeni metni de şifreleyip gönderir.
router.patch(
  '/:chatId/messages/:messageId',
  [param('chatId').isUUID(), param('messageId').isUUID(), body('text').isString().isLength({ min: 1, max: 8000 })],
  async (req, res) => {
    if (invalid(req)) return res.status(400).json({ error: 'Geçersiz istek.' });
    const { chatId, messageId } = req.params;
    try {
      if (!(await assertMember(chatId, req.user.id))) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });
      if (await isChatBlocked(chatId, req.user.id)) return res.status(403).json({ error: 'Bu kişiyle mesajlaşamazsınız.' });
      const found = await pool.query(
        'SELECT sender_id, type, created_at FROM messages WHERE id = $1 AND chat_id = $2',
        [messageId, chatId],
      );
      const row = found.rows[0];
      if (!row || row.sender_id !== req.user.id) return res.status(404).json({ error: 'Mesaj bulunamadı veya size ait değil.' });
      if (row.type !== 'TEXT') return res.status(400).json({ error: 'Yalnızca metin mesajları düzenlenebilir.' });
      if (Date.now() - new Date(row.created_at).getTime() > EDIT_WINDOW_MS) {
        return res.status(403).json({ error: 'Mesaj yalnızca gönderildikten sonraki 15 dakika içinde düzenlenebilir.' });
      }
      await pool.query('UPDATE messages SET text = $3, edited_at = now() WHERE id = $1 AND chat_id = $2', [messageId, chatId, req.body.text]);
      const message = await selectEnrichedMessage(messageId);
      await emitToMembers(req.app.get('io'), chatId, 'message:edited', message);
      res.json({ message });
    } catch (err) {
      console.error('edit message error', err);
      res.status(500).json({ error: 'Mesaj düzenlenemedi.' });
    }
  },
);

// POST /api/chats/:chatId/forward {sourceChatId, messageId} — bir MEDYA mesajını (fotoğraf/video/dosya/ses)
// başka sohbete iletir: baytlar sunucuda kopyalanır, istemci yeniden yüklemez. Metin mesajlarını istemci,
// çözdükten sonra normal gönderimle ("forwarded": true) iletir (birebir metin şifreli olduğundan sunucu kopyalayamaz).
router.post(
  '/:chatId/forward',
  [param('chatId').isUUID(), body('sourceChatId').isUUID(), body('messageId').isUUID()],
  async (req, res) => {
    if (invalid(req)) return res.status(400).json({ error: 'Geçersiz istek.' });
    const { chatId } = req.params;
    const { sourceChatId, messageId } = req.body;
    try {
      if (!(await assertMember(chatId, req.user.id))) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });
      if (!(await assertMember(sourceChatId, req.user.id))) return res.status(403).json({ error: 'Kaynak sohbete erişiminiz yok.' });
      if (await isChatBlocked(chatId, req.user.id)) return res.status(403).json({ error: 'Bu kişiyle mesajlaşamazsınız.' });
      const inserted = await pool.query(
        `INSERT INTO messages (chat_id, sender_id, type, text, media_data, media_mime, media_filename, forwarded)
         SELECT $1, $2, type, text, media_data, media_mime, media_filename, true
           FROM messages WHERE id = $3 AND chat_id = $4 AND media_data IS NOT NULL
         RETURNING id`,
        [chatId, req.user.id, messageId, sourceChatId],
      );
      if (inserted.rows.length === 0) return res.status(404).json({ error: 'İletilecek medya mesajı bulunamadı.' });
      const message = await selectEnrichedMessage(inserted.rows[0].id);
      const io = req.app.get('io');
      await emitToMembers(io, chatId, 'message:new', message);
      notifyOtherMembers(io, chatId, req.user.id, message);
      res.status(201).json({ message });
    } catch (err) {
      console.error('forward error', err);
      res.status(500).json({ error: 'Mesaj iletilemedi.' });
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
    if (await isChatBlocked(chatId, req.user.id)) return res.status(403).json({ error: 'Bu kişiyle mesajlaşamazsınız.' });

    const mime = req.file.mimetype || 'application/octet-stream';
    const type = mime.startsWith('image/') ? 'IMAGE'
      : mime.startsWith('video/') ? 'VIDEO'
        : mime.startsWith('audio/') ? 'VOICE' : 'FILE';
    const duration = type === 'VOICE' && typeof req.body.duration === 'string' ? req.body.duration.slice(0, 10) : null;
    const replyToId = typeof req.body.replyToId === 'string' && UUID_RE.test(req.body.replyToId) ? req.body.replyToId : null;
    if (replyToId && !(await validReplyTarget(chatId, replyToId))) {
      return res.status(400).json({ error: 'Yanıtlanan mesaj bulunamadı.' });
    }

    const inserted = await pool.query(
      `INSERT INTO messages (chat_id, sender_id, type, text, media_data, media_mime, media_filename, reply_to_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [chatId, req.user.id, type, duration, req.file.buffer, mime, req.file.originalname, replyToId],
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

// PATCH /api/chats/:chatId/disappearing {seconds} — per-chat disappearing
// messages timer. seconds: 0/null = off, otherwise 60 – 31 536 000. Any member
// may change it (the timer applies to everyone in the chat). Messages already
// older than the new window are removed by the next 60 s sweep.
router.patch(
  '/:chatId/disappearing',
  [
    param('chatId').isUUID(),
    body('seconds').custom((v) => v === null || v === 0 || (Number.isInteger(v) && v >= 60 && v <= 31_536_000)),
  ],
  async (req, res) => {
    if (invalid(req)) return res.status(400).json({ error: 'Geçersiz süre.' });
    const { chatId } = req.params;
    const seconds = req.body.seconds || null;
    try {
      if (!(await assertMember(chatId, req.user.id))) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });
      await pool.query('UPDATE chats SET disappear_seconds = $2 WHERE id = $1', [chatId, seconds]);
      await emitToMembers(req.app.get('io'), chatId, 'chat:disappear-changed', { chatId, seconds });
      res.json({ chatId, seconds });
    } catch (err) {
      console.error('set disappearing error', err);
      res.status(500).json({ error: 'Süre ayarlanamadı.' });
    }
  },
);

// GET /api/chats/:chatId/members — for the group-info screen.
router.get('/:chatId/members', [param('chatId').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz chatId.' });
  try {
    if (!(await assertMember(req.params.chatId, req.user.id))) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });
    const r = await pool.query(
      `SELECT u.id, u.handle, u.display_name, u.avatar_url, cm.role
         FROM chat_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.chat_id = $1
        ORDER BY (cm.role = 'ADMIN') DESC, cm.joined_at`,
      [req.params.chatId],
    );
    res.json({
      members: r.rows.map((u) => ({
        id: u.id, handle: u.handle, displayName: u.display_name, avatarUrl: u.avatar_url, role: u.role, isAdmin: u.role === 'ADMIN',
      })),
    });
  } catch (err) {
    console.error('get members error', err);
    res.status(500).json({ error: 'Üyeler getirilemedi.' });
  }
});

// POST /api/chats/:chatId/members — add people to a GROUP. Yalnızca grup yöneticileri üye ekleyebilir.
router.post(
  '/:chatId/members',
  [param('chatId').isUUID(), body('memberIds').isArray({ min: 1, max: 50 }), body('memberIds.*').isUUID()],
  async (req, res) => {
    if (invalid(req)) return res.status(400).json({ error: 'Geçersiz istek.' });
    const { chatId } = req.params;
    try {
      const gate = await requireGroupAdmin(chatId, req.user.id);
      if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

      const newIds = [...new Set(req.body.memberIds)];
      const found = await pool.query('SELECT id FROM users WHERE id = ANY($1)', [newIds]);
      if (found.rows.length !== newIds.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

      await pool.query(
        `INSERT INTO chat_members (chat_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
        [chatId, newIds],
      );
      const io = req.app.get('io');
      await emitToMembers(io, chatId, 'chat:members-changed', { chatId });
      newIds.forEach((id) => io?.to(`user:${id}`).emit('chat:created', { chatId }));
      res.status(204).send();
    } catch (err) {
      console.error('add members error', err);
      res.status(500).json({ error: 'Üye eklenemedi.' });
    }
  },
);

// DELETE /api/chats/:chatId/members/me — gruptan ayrıl. Son yönetici ayrılırsa en eski üye yönetici olur;
// kimse kalmazsa grup silinir.
router.delete('/:chatId/members/me', [param('chatId').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz chatId.' });
  const { chatId } = req.params;
  try {
    const chat = await pool.query('SELECT kind FROM chats WHERE id = $1', [chatId]);
    if (chat.rows.length === 0) return res.status(404).json({ error: 'Sohbet bulunamadı.' });
    if (chat.rows[0].kind !== 'GROUP') return res.status(400).json({ error: 'Yalnızca gruplardan ayrılabilirsiniz.' });

    const r = await pool.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, req.user.id]);
    if (r.rowCount === 0) return res.status(403).json({ error: 'Bu sohbete zaten üye değilsiniz.' });

    const io = req.app.get('io');
    const left = await pool.query('SELECT COUNT(*)::int AS n FROM chat_members WHERE chat_id = $1', [chatId]);
    if (left.rows[0].n === 0) {
      await pool.query('DELETE FROM chats WHERE id = $1', [chatId]);
    } else {
      await pool.query(
        `UPDATE chat_members SET role = 'ADMIN'
          WHERE chat_id = $1
            AND NOT EXISTS (SELECT 1 FROM chat_members a WHERE a.chat_id = $1 AND a.role = 'ADMIN')
            AND user_id = (SELECT user_id FROM chat_members WHERE chat_id = $1 ORDER BY joined_at, user_id LIMIT 1)`,
        [chatId],
      );
      await emitToMembers(io, chatId, 'chat:members-changed', { chatId });
    }
    io?.to(`user:${req.user.id}`).emit('chat:left', { chatId });
    res.status(204).send();
  } catch (err) {
    console.error('leave group error', err);
    res.status(500).json({ error: 'Gruptan ayrılınamadı.' });
  }
});

// DELETE /api/chats/:chatId — sohbeti BENDEN sil. Birebir sohbette üyeliğim kalkar (karşı tarafın kopyası durur;
// kimse kalmazsa sohbet tamamen silinir). Gruplarda "Gruptan ayrıl" aynı işi görür.
router.delete('/:chatId', [param('chatId').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz chatId.' });
  const { chatId } = req.params;
  try {
    const chat = await pool.query('SELECT kind FROM chats WHERE id = $1', [chatId]);
    if (chat.rows.length === 0) return res.status(404).json({ error: 'Sohbet bulunamadı.' });
    if (chat.rows[0].kind !== 'DIRECT') return res.status(400).json({ error: 'Gruplardan "Gruptan ayrıl" ile çıkılır.' });
    const r = await pool.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, req.user.id]);
    if (r.rowCount === 0) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });
    const left = await pool.query('SELECT COUNT(*)::int AS n FROM chat_members WHERE chat_id = $1', [chatId]);
    if (left.rows[0].n === 0) await pool.query('DELETE FROM chats WHERE id = $1', [chatId]);
    req.app.get('io')?.to(`user:${req.user.id}`).emit('chat:left', { chatId });
    res.status(204).send();
  } catch (err) {
    console.error('delete chat error', err);
    res.status(500).json({ error: 'Sohbet silinemedi.' });
  }
});

// DELETE /api/chats/:chatId/members/:userId — yönetici, bir üyeyi gruptan çıkarır.
// Yöneticiler doğrudan çıkarılamaz: önce yöneticilikleri kaldırılmalı.
router.delete('/:chatId/members/:userId', [param('chatId').isUUID(), param('userId').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz istek.' });
  const { chatId, userId } = req.params;
  try {
    const gate = await requireGroupAdmin(chatId, req.user.id);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
    if (userId === req.user.id) return res.status(400).json({ error: 'Kendinizi çıkarmak için "Gruptan Ayrıl"ı kullanın.' });
    const targetRole = await memberRole(chatId, userId);
    if (!targetRole) return res.status(404).json({ error: 'Kullanıcı bu grubun üyesi değil.' });
    if (targetRole === 'ADMIN') return res.status(409).json({ error: 'Bir yöneticiyi çıkarmadan önce yöneticiliğini kaldırın.' });

    await pool.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
    const io = req.app.get('io');
    io?.to(`user:${userId}`).emit('chat:left', { chatId });
    await emitToMembers(io, chatId, 'chat:members-changed', { chatId });
    res.status(204).send();
  } catch (err) {
    console.error('remove member error', err);
    res.status(500).json({ error: 'Üye çıkarılamadı.' });
  }
});

// PUT /api/chats/:chatId/members/:userId/role {role: "ADMIN"|"MEMBER"} — yönetici atama / kaldırma.
// Grupta her zaman en az bir yönetici kalır.
router.put(
  '/:chatId/members/:userId/role',
  [param('chatId').isUUID(), param('userId').isUUID(), body('role').isIn(['ADMIN', 'MEMBER'])],
  async (req, res) => {
    if (invalid(req)) return res.status(400).json({ error: 'Geçersiz istek.' });
    const { chatId, userId } = req.params;
    const { role } = req.body;
    try {
      const gate = await requireGroupAdmin(chatId, req.user.id);
      if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
      const targetRole = await memberRole(chatId, userId);
      if (!targetRole) return res.status(404).json({ error: 'Kullanıcı bu grubun üyesi değil.' });
      if (role === 'MEMBER' && targetRole === 'ADMIN') {
        const admins = await pool.query("SELECT COUNT(*)::int AS n FROM chat_members WHERE chat_id = $1 AND role = 'ADMIN'", [chatId]);
        if (admins.rows[0].n <= 1) return res.status(409).json({ error: 'Grupta en az bir yönetici kalmalı.' });
      }
      await pool.query('UPDATE chat_members SET role = $3 WHERE chat_id = $1 AND user_id = $2', [chatId, userId, role]);
      await emitToMembers(req.app.get('io'), chatId, 'chat:members-changed', { chatId });
      res.json({ userId, role });
    } catch (err) {
      console.error('set role error', err);
      res.status(500).json({ error: 'Rol değiştirilemedi.' });
    }
  },
);

// PATCH /api/chats/:chatId {title} — grubu yeniden adlandır (yönetici).
router.patch('/:chatId', [param('chatId').isUUID(), body('title').trim().isLength({ min: 1, max: 60 })], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz istek.' });
  const { chatId } = req.params;
  try {
    const gate = await requireGroupAdmin(chatId, req.user.id);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
    await pool.query('UPDATE chats SET title = $2 WHERE id = $1', [chatId, req.body.title]);
    await emitToMembers(req.app.get('io'), chatId, 'chat:updated', { chatId });
    res.json({ chatId, title: req.body.title });
  } catch (err) {
    console.error('rename group error', err);
    res.status(500).json({ error: 'Grup adı değiştirilemedi.' });
  }
});

// PUT /api/chats/:chatId/photo — grup fotoğrafı (multipart alan adı "file"; JPEG/PNG/WebP, ≤ 2 MB). Yönetici.
router.put('/:chatId/photo', [param('chatId').isUUID()], (req, res, next) => {
  photoUpload.single('file')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'Fotoğraf en fazla 2 MB olabilir.' : 'Yükleme başarısız.' });
    }
    return next();
  });
}, async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz chatId.' });
  if (!req.file) return res.status(400).json({ error: 'Dosya eksik (multipart alan adı: "file").' });
  const mime = sniffImageMime(req.file.buffer);
  if (!mime) return res.status(400).json({ error: 'Yalnızca JPEG, PNG veya WebP yüklenebilir.' });
  const { chatId } = req.params;
  try {
    const gate = await requireGroupAdmin(chatId, req.user.id);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
    const url = `${req.protocol}://${req.get('host')}/api/chats/${chatId}/photo?v=${Date.now()}`;
    await pool.query('UPDATE chats SET photo_data = $2, photo_mime = $3, photo_url = $4 WHERE id = $1', [chatId, req.file.buffer, mime, url]);
    await emitToMembers(req.app.get('io'), chatId, 'chat:updated', { chatId });
    res.json({ chatId, photoUrl: url });
  } catch (err) {
    console.error('put group photo error', err);
    res.status(500).json({ error: 'Fotoğraf kaydedilemedi.' });
  }
});

// DELETE /api/chats/:chatId/photo — grup fotoğrafını kaldır (yönetici).
router.delete('/:chatId/photo', [param('chatId').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz chatId.' });
  const { chatId } = req.params;
  try {
    const gate = await requireGroupAdmin(chatId, req.user.id);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
    await pool.query('UPDATE chats SET photo_data = NULL, photo_mime = NULL, photo_url = NULL WHERE id = $1', [chatId]);
    await emitToMembers(req.app.get('io'), chatId, 'chat:updated', { chatId });
    res.status(204).send();
  } catch (err) {
    console.error('delete group photo error', err);
    res.status(500).json({ error: 'Fotoğraf kaldırılamadı.' });
  }
});

// GET /api/chats/:chatId/photo — yalnızca grup üyeleri görebilir.
router.get('/:chatId/photo', [param('chatId').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz chatId.' });
  try {
    if (!(await assertMember(req.params.chatId, req.user.id))) return res.status(403).json({ error: 'Bu sohbete erişiminiz yok.' });
    const r = await pool.query('SELECT photo_data, photo_mime FROM chats WHERE id = $1', [req.params.chatId]);
    if (r.rows.length === 0 || !r.rows[0].photo_data) return res.status(404).json({ error: 'Fotoğraf yok.' });
    res.setHeader('Content-Type', r.rows[0].photo_mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(r.rows[0].photo_data);
  } catch (err) {
    console.error('get group photo error', err);
    res.status(500).json({ error: 'Fotoğraf getirilemedi.' });
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
