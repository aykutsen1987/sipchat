const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// POST /api/push/register — called after login and whenever FCM rotates
// the token (FirebaseMessagingService.onNewToken). A token can only ever
// belong to one user at a time — re-registering under a new account moves
// it (e.g. after logout/login as someone else on the same device).
router.post(
  '/register',
  [body('token').isString().isLength({ min: 10, max: 4096 })],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ error: 'Geçersiz token.' });
    }
    try {
      await pool.query(
        `INSERT INTO push_tokens (token, user_id, platform)
         VALUES ($1, $2, 'android')
         ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id`,
        [req.body.token, req.user.id],
      );
      res.status(204).send();
    } catch (err) {
      console.error('push register error', err);
      res.status(500).json({ error: 'Token kaydedilemedi.' });
    }
  },
);

// POST /api/push/unregister — called on logout so a signed-out device stops
// receiving pushes for the account it just left.
router.post(
  '/unregister',
  [body('token').isString().isLength({ min: 10, max: 4096 })],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ error: 'Geçersiz token.' });
    }
    try {
      await pool.query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [req.body.token, req.user.id]);
      res.status(204).send();
    } catch (err) {
      console.error('push unregister error', err);
      res.status(500).json({ error: 'Token silinemedi.' });
    }
  },
);

module.exports = router;
