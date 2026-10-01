const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

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

