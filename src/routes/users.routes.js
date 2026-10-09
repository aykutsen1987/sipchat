const express = require('express');
const multer = require('multer');
const { body, param, query, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Profile photos: the client downsizes to ~512px JPEG first; 2 MB is a hard
// server-side ceiling regardless.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AVATAR_BYTES } });

/** Detects the real image type from magic bytes (the client-supplied MIME is not trusted). */
function sniffImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

const toPublicUser = (u) => ({ id: u.id, handle: u.handle, displayName: u.display_name, avatarUrl: u.avatar_url });

// PUT /api/users/me/key — publish/replace my E2E public key (Tink hybrid
// keyset, base64). Called once per device after first login/register and
// again if the local keyset is ever regenerated. The server only ever sees
// the PUBLIC half — see Android's E2eKeyManager.kt.
router.put(
  '/me/key',
  [body('publicKey').isString().isLength({ min: 1, max: 20000 })],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ error: 'Geçersiz publicKey.' });
    }
    try {
      await pool.query(
        `INSERT INTO user_keys (user_id, public_key, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET public_key = EXCLUDED.public_key, updated_at = now()`,
        [req.user.id, req.body.publicKey],
      );
      res.status(204).send();
    } catch (err) {
      console.error('put key error', err);
      res.status(500).json({ error: 'Anahtar kaydedilemedi.' });
    }
  },
);

// PUT /api/users/me/avatar — multipart field "file" (JPEG/PNG/WebP, ≤ 2 MB).
// avatar_url becomes an absolute URL to GET /api/users/:id/avatar with a
// cache-busting ?v= so every client refreshes the picture immediately.
router.put('/me/avatar', (req, res, next) => {
  avatarUpload.single('file')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'Fotoğraf en fazla 2 MB olabilir.' : 'Yükleme başarısız.' });
    }
    return next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya eksik (multipart alan adı: "file").' });
  const mime = sniffImageMime(req.file.buffer);
  if (!mime) return res.status(400).json({ error: 'Yalnızca JPEG, PNG veya WebP yüklenebilir.' });
  try {
    const url = `${req.protocol}://${req.get('host')}/api/users/${req.user.id}/avatar?v=${Date.now()}`;
    const r = await pool.query(
      `UPDATE users SET avatar_data = $2, avatar_mime = $3, avatar_url = $4
        WHERE id = $1 RETURNING id, handle, display_name, avatar_url`,
      [req.user.id, req.file.buffer, mime, url],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    res.json({ user: toPublicUser(r.rows[0]) });
  } catch (err) {
    console.error('put avatar error', err);
    res.status(500).json({ error: 'Fotoğraf kaydedilemedi.' });
  }
});

// DELETE /api/users/me/avatar — back to no picture.
router.delete('/me/avatar', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE users SET avatar_data = NULL, avatar_mime = NULL, avatar_url = NULL
        WHERE id = $1 RETURNING id, handle, display_name, avatar_url`,
      [req.user.id],
    );
    res.json({ user: toPublicUser(r.rows[0]) });
  } catch (err) {
    console.error('delete avatar error', err);
    res.status(500).json({ error: 'Fotoğraf kaldırılamadı.' });
  }
});

// GET /api/users/:userId/avatar — any signed-in user may view any profile photo.
router.get('/:userId/avatar', [param('userId').isUUID()], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz kullanıcı.' });
  try {
    const r = await pool.query('SELECT avatar_data, avatar_mime FROM users WHERE id = $1', [req.params.userId]);
    if (r.rows.length === 0 || !r.rows[0].avatar_data) return res.status(404).json({ error: 'Fotoğraf yok.' });
    res.setHeader('Content-Type', r.rows[0].avatar_mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(r.rows[0].avatar_data);
  } catch (err) {
    console.error('get avatar error', err);
    res.status(500).json({ error: 'Fotoğraf getirilemedi.' });
  }
});

// GET /api/users/search?q=... — find people to start a chat with (handle or
// display name, min 2 chars, never returns myself OR anyone blocking/blocked).
router.get('/search', [query('q').isString().trim().isLength({ min: 2, max: 40 })], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'En az 2 karakter girin.' });
  try {
    const escaped = req.query.q.trim().replace(/[\\%_]/g, (c) => '\\' + c);
    const pattern = '%' + escaped + '%';
    const r = await pool.query(
      `SELECT id, handle, display_name, avatar_url FROM users
        WHERE id != $1 AND (handle ILIKE $2 OR display_name ILIKE $2)
          AND id NOT IN (
            SELECT blocked_id FROM blocked_users WHERE blocker_id = $1
            UNION
            SELECT blocker_id FROM blocked_users WHERE blocked_id = $1
          )
        ORDER BY handle LIMIT 20`,
      [req.user.id, pattern],
    );
    res.json({
      users: r.rows.map((u) => ({ id: u.id, handle: u.handle, displayName: u.display_name, avatarUrl: u.avatar_url })),
    });
  } catch (err) {
    console.error('user search error', err);
    res.status(500).json({ error: 'Arama başarısız.' });
  }
});

// POST /api/users/:userId/block — blocks in one direction, but isBlocked()
// (realtime.js) treats it as mutual for messaging/search purposes.
router.post('/:userId/block', [param('userId').isUUID()], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz kullanıcı.' });
  if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Kendinizi engelleyemezsiniz.' });
  try {
    await pool.query(
      `INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [req.user.id, req.params.userId],
    );
    res.status(204).send();
  } catch (err) {
    console.error('block error', err);
    res.status(500).json({ error: 'Engellenemedi.' });
  }
});

// POST /api/users/:userId/unblock
router.post('/:userId/unblock', [param('userId').isUUID()], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz kullanıcı.' });
  try {
    await pool.query('DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2', [req.user.id, req.params.userId]);
    res.status(204).send();
  } catch (err) {
    console.error('unblock error', err);
    res.status(500).json({ error: 'Engel kaldırılamadı.' });
  }
});

// GET /api/users/blocked — people I have blocked (not people who blocked me).
router.get('/blocked', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.handle, u.display_name, u.avatar_url
         FROM blocked_users bu JOIN users u ON u.id = bu.blocked_id
        WHERE bu.blocker_id = $1
        ORDER BY bu.created_at DESC`,
      [req.user.id],
    );
    res.json({
      users: r.rows.map((u) => ({ id: u.id, handle: u.handle, displayName: u.display_name, avatarUrl: u.avatar_url })),
    });
  } catch (err) {
    console.error('list blocked error', err);
    res.status(500).json({ error: 'Liste getirilemedi.' });
  }
});

module.exports = router;

