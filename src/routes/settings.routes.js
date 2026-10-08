const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function toPublicSettings(row) {
  return {
    readReceiptsEnabled: row.read_receipts_enabled,
    showLastSeen: row.show_last_seen,
    messagePreviewsEnabled: row.message_previews_enabled,
    disappearingDefaultSeconds: row.disappearing_default_seconds,
    twoFactorEnabled: row.two_factor_enabled,
  };
}

// GET /api/settings — every user has a row (created at registration), but
// upsert defensively in case this account predates that.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO user_settings (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING *`,
      [req.user.id],
    );
    const row = result.rows[0] || (await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [req.user.id])).rows[0];
    res.json(toPublicSettings(row));
  } catch (err) {
    console.error('get settings error', err);
    res.status(500).json({ error: 'Ayarlar getirilemedi.' });
  }
});

// PATCH /api/settings — partial update; only send the fields that changed.
router.patch(
  '/',
  [
    body('readReceiptsEnabled').optional().isBoolean(),
    body('showLastSeen').optional().isBoolean(),
    body('messagePreviewsEnabled').optional().isBoolean(),
    // null clears it (disappearing messages off by default); 0 is not allowed (use null instead).
    body('disappearingDefaultSeconds').optional({ nullable: true }).isInt({ min: 60, max: 31_536_000 }),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz değer.' });

    const fields = [];
    const values = [];
    const push = (column, value) => { fields.push(`${column} = $${fields.length + 1}`); values.push(value); };

    if ('readReceiptsEnabled' in req.body) push('read_receipts_enabled', req.body.readReceiptsEnabled);
    if ('showLastSeen' in req.body) push('show_last_seen', req.body.showLastSeen);
    if ('messagePreviewsEnabled' in req.body) push('message_previews_enabled', req.body.messagePreviewsEnabled);
    if ('disappearingDefaultSeconds' in req.body) push('disappearing_default_seconds', req.body.disappearingDefaultSeconds);

    if (fields.length === 0) return res.status(400).json({ error: 'Güncellenecek bir alan yok.' });

    try {
      // Ensure a row exists (older accounts, or anything that slipped
      // through registration without one), then apply the update.
      await pool.query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [req.user.id]);

      values.push(req.user.id);
      const result = await pool.query(
        `UPDATE user_settings SET ${fields.join(', ')}, updated_at = now() WHERE user_id = $${values.length} RETURNING *`,
        values,
      );
      res.json(toPublicSettings(result.rows[0]));
    } catch (err) {
      console.error('patch settings error', err);
      res.status(500).json({ error: 'Ayarlar güncellenemedi.' });
    }
  },
);

module.exports = router;
