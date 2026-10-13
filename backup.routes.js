const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// The body is an opaque blob the CLIENT already encrypted (AES-256-GCM with a
// key derived from the user's backup password) — the server never sees the
// password or any plaintext. One slot per user; a new upload replaces the old.
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

// PUT /api/backup — raw bytes (Content-Type: application/octet-stream).
router.put(
  '/',
  express.raw({ type: '*/*', limit: MAX_BACKUP_BYTES }),
  async (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'Yedek verisi boş.' });
    try {
      const r = await pool.query(
        `INSERT INTO user_backups (user_id, data, size_bytes, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, size_bytes = EXCLUDED.size_bytes, updated_at = now()
         RETURNING size_bytes, updated_at`,
        [req.user.id, body, body.length],
      );
      res.json({ sizeBytes: r.rows[0].size_bytes, updatedAt: r.rows[0].updated_at });
    } catch (err) {
      console.error('put backup error', err);
      res.status(500).json({ error: 'Yedek yüklenemedi.' });
    }
  },
);

// GET /api/backup/info — does a cloud backup exist, how big, and when.
router.get('/info', async (req, res) => {
  try {
    const r = await pool.query('SELECT size_bytes, updated_at FROM user_backups WHERE user_id = $1', [req.user.id]);
    if (r.rows.length === 0) return res.json({ exists: false });
    res.json({ exists: true, sizeBytes: r.rows[0].size_bytes, updatedAt: r.rows[0].updated_at });
  } catch (err) {
    console.error('backup info error', err);
    res.status(500).json({ error: 'Yedek bilgisi alınamadı.' });
  }
});

// GET /api/backup — download the encrypted blob.
router.get('/', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM user_backups WHERE user_id = $1', [req.user.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Bulutta yedek yok.' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.send(r.rows[0].data);
  } catch (err) {
    console.error('get backup error', err);
    res.status(500).json({ error: 'Yedek indirilemedi.' });
  }
});

// DELETE /api/backup
router.delete('/', async (req, res) => {
  try {
    await pool.query('DELETE FROM user_backups WHERE user_id = $1', [req.user.id]);
    res.status(204).send();
  } catch (err) {
    console.error('delete backup error', err);
    res.status(500).json({ error: 'Yedek silinemedi.' });
  }
});

module.exports = router;
