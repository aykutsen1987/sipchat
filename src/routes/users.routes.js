const express = require('express');
const { body, query, validationResult } = require('express-validator');
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
// display name, min 2 chars, never returns myself).
router.get('/search', [query('q').isString().trim().isLength({ min: 2, max: 40 })], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'En az 2 karakter girin.' });
  try {
    const escaped = req.query.q.trim().replace(/[\\%_]/g, (c) => '\\' + c);
    const pattern = '%' + escaped + '%';
    const r = await pool.query(
      `SELECT id, handle, display_name, avatar_url FROM users
        WHERE id != $1 AND (handle ILIKE $2 OR display_name ILIKE $2)
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

module.exports = router;

