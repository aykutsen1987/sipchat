const express = require('express');
const { param, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/sessions — "Bağlı Cihazlar" screen: every non-revoked session for
// the caller, newest first, flagging which one is the request being made
// right now.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, device_name, created_at, last_seen_at
         FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY last_seen_at DESC`,
      [req.user.id],
    );
    res.json({
      sessions: result.rows.map((row) => ({
        id: row.id,
        deviceName: row.device_name,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        isCurrent: row.id === req.sessionId,
      })),
    });
  } catch (err) {
    console.error('list sessions error', err);
    res.status(500).json({ error: 'Cihazlar getirilemedi.' });
  }
});

// DELETE /api/sessions/:sessionId — sign that device out. Revoking the
// session making this very request is allowed (equivalent to "log out"); the
// response still succeeds, but the NEXT request with that token will 401.
router.delete('/:sessionId', [param('sessionId').isUUID()], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz sessionId.' });
  try {
    const result = await pool.query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [req.params.sessionId, req.user.id],
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Oturum bulunamadı.' });
    res.status(204).send();
  } catch (err) {
    console.error('revoke session error', err);
    res.status(500).json({ error: 'Oturum sonlandırılamadı.' });
  }
});

module.exports = router;
