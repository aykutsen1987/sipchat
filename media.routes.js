const express = require('express');
const { param, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/media/:messageId — only a member of the message's chat can fetch
// the bytes. Used as the "mediaUrl" for IMAGE/FILE messages; the Android
// client's Coil image loader attaches the same Bearer token automatically
// (see AuthInterceptor.kt), so this never needs to be publicly readable.
router.get(
  '/:messageId',
  [param('messageId').isUUID()],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ error: 'Geçersiz messageId.' });
    }

    try {
      const result = await pool.query(
        `SELECT m.media_data, m.media_mime, m.media_filename, m.chat_id
           FROM messages m
          WHERE m.id = $1`,
        [req.params.messageId],
      );

      if (result.rows.length === 0 || !result.rows[0].media_data) {
        return res.status(404).json({ error: 'Medya bulunamadı.' });
      }

      const media = result.rows[0];
      const membership = await pool.query(
        'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
        [media.chat_id, req.user.id],
      );
      if (membership.rows.length === 0) {
        return res.status(403).json({ error: 'Bu medyaya erişiminiz yok.' });
      }

      res.setHeader('Content-Type', media.media_mime || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      if (media.media_filename) {
        res.setHeader('Content-Disposition', `inline; filename="${media.media_filename}"`);
      }
      res.send(media.media_data);
    } catch (err) {
      console.error('get media error', err);
      res.status(500).json({ error: 'Medya getirilemedi.' });
    }
  },
);

module.exports = router;
