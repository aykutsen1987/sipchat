const express = require('express');
const multer = require('multer');
const { body, param, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const MAX_ACTIVE_PER_USER = 30;
const MODES = ['ALL', 'EXCEPT', 'ONLY'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MEDIA_BYTES, fields: 5 } });
const invalid = (req) => !validationResult(req).isEmpty();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kişiler = en az bir sohbeti paylaştıklarım, engel ilişkisi olmayanlar. */
async function contacts(userId) {
  const r = await pool.query(
    `SELECT DISTINCT u.id AS user_id, u.handle, u.display_name, u.avatar_url
       FROM chat_members a
       JOIN chat_members b ON a.chat_id = b.chat_id AND b.user_id <> a.user_id
       JOIN users u ON u.id = b.user_id
      WHERE a.user_id = $1
        AND NOT EXISTS (SELECT 1 FROM blocked_users x
                         WHERE (x.blocker_id = $1 AND x.blocked_id = u.id) OR (x.blocker_id = u.id AND x.blocked_id = $1))
      ORDER BY u.display_name`,
    [userId],
  );
  return r.rows;
}

async function getPrivacy(userId) {
  const m = await pool.query('SELECT status_visibility FROM user_settings WHERE user_id = $1', [userId]);
  const mode = m.rows[0]?.status_visibility || 'ALL';
  const u = await pool.query('SELECT contact_id FROM status_privacy_users WHERE user_id = $1', [userId]);
  return { mode, userIds: u.rows.map((x) => x.contact_id) };
}

/** Durumumu görebilecek kişiler: gizlilik ayarı uygulanmış kişiler, açık anahtarı olanlar. */
async function audienceFor(userId) {
  const [all, privacy] = await Promise.all([contacts(userId), getPrivacy(userId)]);
  const keys = await pool.query(
    'SELECT user_id, public_key FROM user_keys WHERE user_id = ANY($1::uuid[])',
    [all.map((c) => c.user_id)],
  );
  const keyOf = new Map(keys.rows.map((k) => [k.user_id, k.public_key]));
  const picked = new Set(privacy.userIds);
  const allowed = all.filter((c) => {
    if (privacy.mode === 'EXCEPT') return !picked.has(c.user_id);
    if (privacy.mode === 'ONLY') return picked.has(c.user_id);
    return true;
  });
  return {
    contacts: all,
    privacy,
    audience: allowed
      .filter((c) => keyOf.has(c.user_id))
      .map((c) => ({ userId: c.user_id, handle: c.handle, displayName: c.display_name, publicKey: keyOf.get(c.user_id) })),
  };
}

// GET /api/status/audience — kime gösterileceği + gizlilik + tüm kişilerim
router.get('/audience', async (req, res) => {
  try {
    const a = await audienceFor(req.user.id);
    res.json({
      audience: a.audience,
      privacy: a.privacy,
      contacts: a.contacts.map((c) => ({ userId: c.user_id, handle: c.handle, displayName: c.display_name, avatarUrl: c.avatar_url })),
    });
  } catch (err) {
    console.error('status audience error', err);
    res.status(500).json({ error: 'Kişiler alınamadı.' });
  }
});

// PUT /api/status/privacy {mode, userIds}
router.put(
  '/privacy',
  [body('mode').isIn(MODES), body('userIds').optional().isArray({ max: 1000 })],
  async (req, res) => {
    if (invalid(req)) return res.status(400).json({ error: 'Geçersiz gizlilik ayarı.' });
    const { mode } = req.body;
    const ids = (req.body.userIds || []).filter((x) => typeof x === 'string' && UUID.test(x));
    if (mode !== 'ALL' && ids.length === 0) {
      return res.status(400).json({ error: 'En az bir kişi seçin.' });
    }
    const client = await pool.connect();
    try {
      const mine = new Set((await contacts(req.user.id)).map((c) => c.user_id));
      const valid = [...new Set(ids)].filter((x) => mine.has(x));
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO user_settings (user_id, status_visibility) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET status_visibility = EXCLUDED.status_visibility`,
        [req.user.id, mode],
      );
      await client.query('DELETE FROM status_privacy_users WHERE user_id = $1', [req.user.id]);
      if (valid.length) {
        await client.query(
          'INSERT INTO status_privacy_users (user_id, contact_id) SELECT $1, unnest($2::uuid[])',
          [req.user.id, valid],
        );
      }
      await client.query('COMMIT');
      res.json({ mode, userIds: valid });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('status privacy error', err);
      res.status(500).json({ error: 'Gizlilik kaydedilemedi.' });
    } finally {
      client.release();
    }
  },
);

// POST /api/status — multipart: alan "meta" (JSON metin), dosya "media" (şifreli görsel, isteğe bağlı)
// meta: { kind, payloadEnc, selfWrappedKey, wrappedKeys: [{userId, wrappedKey}] }
router.post('/', (req, res, next) => {
  upload.single('media')(req, res, (err) => {
    if (err) {
      const big = err.code === 'LIMIT_FILE_SIZE';
      return res.status(big ? 413 : 400).json({ error: big ? 'Görsel en fazla 5 MB olabilir.' : 'Yükleme başarısız.' });
    }
    return next();
  });
}, async (req, res) => {
  let meta;
  try { meta = JSON.parse(req.body.meta || ''); } catch (e) { return res.status(400).json({ error: 'meta geçersiz.' }); }
  const { kind, payloadEnc, selfWrappedKey, wrappedKeys } = meta || {};
  if (!['TEXT', 'IMAGE'].includes(kind)) return res.status(400).json({ error: 'Geçersiz tür.' });
  if (typeof payloadEnc !== 'string' || payloadEnc.length < 10 || payloadEnc.length > 6000) return res.status(400).json({ error: 'Geçersiz içerik.' });
  if (typeof selfWrappedKey !== 'string' || !selfWrappedKey) return res.status(400).json({ error: 'Kendi anahtarınız eksik.' });
  if (!Array.isArray(wrappedKeys) || wrappedKeys.length > 1000) return res.status(400).json({ error: 'Anahtar listesi geçersiz.' });
  if (kind === 'IMAGE' && !req.file) return res.status(400).json({ error: 'Görsel eksik.' });
  if (kind === 'TEXT' && req.file) return res.status(400).json({ error: 'Yazı durumunda görsel olamaz.' });

  const client = await pool.connect();
  try {
    const active = await pool.query('SELECT COUNT(*)::int AS n FROM statuses WHERE user_id = $1 AND expires_at > now()', [req.user.id]);
    if (active.rows[0].n >= MAX_ACTIVE_PER_USER) {
      return res.status(429).json({ error: `En fazla ${MAX_ACTIVE_PER_USER} aktif durumunuz olabilir.` });
    }
    // Sunucu, izleyici listesini KENDİ hesaplar: istemci kitleyi genişletemez (gizlilik/engel).
    const { audience } = await audienceFor(req.user.id);
    const allowed = new Set(audience.map((a) => a.userId));
    for (const w of wrappedKeys) {
      if (!w || typeof w.userId !== 'string' || typeof w.wrappedKey !== 'string' || !allowed.has(w.userId)) {
        return res.status(409).json({ error: 'Kişi listesi değişti; yeniden deneyin.' });
      }
    }

    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO statuses (user_id, kind, payload_enc, media_data) VALUES ($1, $2, $3, $4)
       RETURNING id, created_at, expires_at`,
      [req.user.id, kind, payloadEnc, req.file ? req.file.buffer : null],
    );
    const id = ins.rows[0].id;
    const rows = [{ userId: req.user.id, wrappedKey: selfWrappedKey }, ...wrappedKeys.filter((w) => w.userId !== req.user.id)];
    await client.query(
      'INSERT INTO status_keys (status_id, viewer_id, wrapped_key) SELECT $1, unnest($2::uuid[]), unnest($3::text[])',
      [id, rows.map((r) => r.userId), rows.map((r) => r.wrappedKey)],
    );
    await client.query('COMMIT');

    const io = req.app.get('io');
    for (const r of rows) io?.to(`user:${r.userId}`).emit('status:new', { statusId: id, authorId: req.user.id });
    res.status(201).json({ id, createdAt: ins.rows[0].created_at, expiresAt: ins.rows[0].expires_at, sharedWith: rows.length - 1 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('post status error', err);
    res.status(500).json({ error: 'Durum paylaşılamadı.' });
  } finally {
    client.release();
  }
});

// GET /api/status/feed — benim için anahtarı olan, süresi dolmamış, engelsiz durumlar (kendiminkiler dahil)
router.get('/feed', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.user_id, u.handle, u.display_name, u.avatar_url, s.kind, s.payload_enc, k.wrapped_key,
              (s.media_data IS NOT NULL) AS has_media, s.created_at, s.expires_at,
              EXISTS (SELECT 1 FROM status_views v WHERE v.status_id = s.id AND v.viewer_id = $1) AS viewed,
              CASE WHEN s.user_id = $1 THEN (SELECT COUNT(*)::int FROM status_views v WHERE v.status_id = s.id) END AS view_count
         FROM statuses s
         JOIN status_keys k ON k.status_id = s.id AND k.viewer_id = $1
         JOIN users u ON u.id = s.user_id
        WHERE s.expires_at > now()
          AND NOT EXISTS (SELECT 1 FROM blocked_users x
                           WHERE (x.blocker_id = $1 AND x.blocked_id = s.user_id) OR (x.blocker_id = s.user_id AND x.blocked_id = $1))
        ORDER BY s.created_at ASC`,
      [req.user.id],
    );
    res.json({
      statuses: r.rows.map((s) => ({
        id: s.id, authorId: s.user_id, handle: s.handle, displayName: s.display_name, avatarUrl: s.avatar_url,
        kind: s.kind, payloadEnc: s.payload_enc, wrappedKey: s.wrapped_key, hasMedia: s.has_media,
        createdAt: s.created_at, expiresAt: s.expires_at, viewed: s.viewed, viewCount: s.view_count,
      })),
    });
  } catch (err) {
    console.error('status feed error', err);
    res.status(500).json({ error: 'Durumlar alınamadı.' });
  }
});

// GET /api/status/:id/media — yalnızca anahtarı olan izleyici (şifreli baytlar)
router.get('/:id/media', [param('id').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz id.' });
  try {
    const r = await pool.query(
      `SELECT s.media_data FROM statuses s JOIN status_keys k ON k.status_id = s.id AND k.viewer_id = $2
        WHERE s.id = $1 AND s.expires_at > now() AND s.media_data IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM blocked_users x
                           WHERE (x.blocker_id = $2 AND x.blocked_id = s.user_id) OR (x.blocker_id = s.user_id AND x.blocked_id = $2))`,
      [req.params.id, req.user.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Görsel bulunamadı.' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(r.rows[0].media_data);
  } catch (err) {
    console.error('status media error', err);
    res.status(500).json({ error: 'Görsel alınamadı.' });
  }
});

// POST /api/status/:id/view — görüldü. "Okundu bilgisi" kapalıysa kayıt tutulmaz.
router.post('/:id/view', [param('id').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz id.' });
  try {
    const s = await pool.query(
      `SELECT s.user_id FROM statuses s JOIN status_keys k ON k.status_id = s.id AND k.viewer_id = $2
        WHERE s.id = $1 AND s.expires_at > now()`,
      [req.params.id, req.user.id],
    );
    if (!s.rows.length) return res.status(404).json({ error: 'Durum bulunamadı.' });
    if (s.rows[0].user_id !== req.user.id) {
      const set = await pool.query('SELECT read_receipts_enabled FROM user_settings WHERE user_id = $1', [req.user.id]);
      if (set.rows[0]?.read_receipts_enabled !== false) {
        await pool.query(
          'INSERT INTO status_views (status_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [req.params.id, req.user.id],
        );
      }
    }
    res.status(204).send();
  } catch (err) {
    console.error('status view error', err);
    res.status(500).json({ error: 'İşlenemedi.' });
  }
});

// GET /api/status/:id/viewers — yalnızca sahibi. Kendi okundu bilgisi kapalıysa liste gizlenir.
router.get('/:id/viewers', [param('id').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz id.' });
  try {
    const own = await pool.query('SELECT 1 FROM statuses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Durum bulunamadı.' });
    const set = await pool.query('SELECT read_receipts_enabled FROM user_settings WHERE user_id = $1', [req.user.id]);
    if (set.rows[0]?.read_receipts_enabled === false) return res.json({ hidden: true, viewers: [] });
    const r = await pool.query(
      `SELECT u.id, u.handle, u.display_name, u.avatar_url, v.viewed_at
         FROM status_views v JOIN users u ON u.id = v.viewer_id
        WHERE v.status_id = $1 ORDER BY v.viewed_at DESC`,
      [req.params.id],
    );
    res.json({
      hidden: false,
      viewers: r.rows.map((v) => ({ userId: v.id, handle: v.handle, displayName: v.display_name, avatarUrl: v.avatar_url, viewedAt: v.viewed_at })),
    });
  } catch (err) {
    console.error('status viewers error', err);
    res.status(500).json({ error: 'Liste alınamadı.' });
  }
});

// DELETE /api/status/:id — yalnızca sahibi
router.delete('/:id', [param('id').isUUID()], async (req, res) => {
  if (invalid(req)) return res.status(400).json({ error: 'Geçersiz id.' });
  try {
    const viewers = await pool.query(
      `SELECT k.viewer_id FROM status_keys k JOIN statuses s ON s.id = k.status_id
        WHERE s.id = $1 AND s.user_id = $2`,
      [req.params.id, req.user.id],
    );
    const del = await pool.query('DELETE FROM statuses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (del.rowCount === 0) return res.status(404).json({ error: 'Durum bulunamadı.' });
    const io = req.app.get('io');
    for (const v of viewers.rows) io?.to(`user:${v.viewer_id}`).emit('status:deleted', { statusId: req.params.id });
    res.status(204).send();
  } catch (err) {
    console.error('status delete error', err);
    res.status(500).json({ error: 'Silinemedi.' });
  }
});

module.exports = router;
