const express = require('express');
const { body, param, validationResult } = require('express-validator');
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

module.exports = router;

