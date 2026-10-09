const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { emitToMembers } = require('../realtime');
const { countRemainingBackupCodes } = require('../twofactor');

const router = express.Router();
router.use(requireAuth);

async function toPublicSettings(row) {
  return {
    readReceiptsEnabled: row.read_receipts_enabled,
    showLastSeen: row.show_last_seen,
    messagePreviewsEnabled: row.message_previews_enabled,
    disappearingDefaultSeconds: row.disappearing_default_seconds,
    twoFactorEnabled: row.two_factor_enabled,
    backupCodesRemaining: row.two_factor_enabled ? await countRemainingBackupCodes(row.user_id) : 0,
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
    res.json(await toPublicSettings(row));
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
    // null OR 0 turns it off (0 exists because the Android client's JSON
    // serializer drops nulls); otherwise 60s – 1 year.
    body('disappearingDefaultSeconds').optional({ nullable: true }).custom((v) => {
      if (v === null || v === 0) return true;
      return Number.isInteger(v) && v >= 60 && v <= 31_536_000;
    }),
    // When true, the new default is also applied to every chat I'm already in.
    body('applyToExistingChats').optional().isBoolean(),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz değer.' });

    const fields = [];
    const values = [];
    const push = (column, value) => { fields.push(`${column} = $${fields.length + 1}`); values.push(value); };

    if ('readReceiptsEnabled' in req.body) push('read_receipts_enabled', req.body.readReceiptsEnabled);
    if ('showLastSeen' in req.body) push('show_last_seen', req.body.showLastSeen);
    if ('messagePreviewsEnabled' in req.body) push('message_previews_enabled', req.body.messagePreviewsEnabled);
    const hasDisappearing = 'disappearingDefaultSeconds' in req.body;
    // 0 is normalised to NULL (= off).
    const disappearing = hasDisappearing ? (req.body.disappearingDefaultSeconds || null) : null;
    if (hasDisappearing) push('disappearing_default_seconds', disappearing);

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

      // "Mevcut sohbetlere de uygula": a disappearing-messages timer is a
      // per-CHAT property that every member sees, so this changes the chats
      // I share with others too (like toggling it inside a chat would).
      // The 60s sweep then removes messages already older than the new
      // window — the client warns about that before sending this flag.
      if (hasDisappearing && req.body.applyToExistingChats === true) {
        const changed = await pool.query(
          `UPDATE chats SET disappear_seconds = $2
            WHERE id IN (SELECT chat_id FROM chat_members WHERE user_id = $1)
              AND disappear_seconds IS DISTINCT FROM $2
          RETURNING id`,
          [req.user.id, disappearing],
        );
        const io = req.app.get('io');
        for (const row of changed.rows) {
          // eslint-disable-next-line no-await-in-loop
          await emitToMembers(io, row.id, 'chat:disappear-changed', { chatId: row.id, seconds: disappearing });
        }
      }

      res.json(await toPublicSettings(result.rows[0]));
    } catch (err) {
      console.error('patch settings error', err);
      res.status(500).json({ error: 'Ayarlar güncellenemedi.' });
    }
  },
);

module.exports = router;
