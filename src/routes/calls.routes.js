const express = require('express');
const { param, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/calls/ice-servers — STUN her zaman; TURN yalnızca env ayarlıysa
// (TURN_URLS="turn:host:3478,turns:host:5349", TURN_USERNAME, TURN_CREDENTIAL).
// TURN, simetrik NAT / mobil operatör arkasındaki aramaların bağlanması için gerekir.
router.get('/ice-servers', (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const urls = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (urls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.json({ iceServers });
});

// GET /api/calls — son 100 arama (benim tarafımdan gizlenmeyenler)
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id, c.chat_id, c.call_type, c.status, c.started_at, c.answered_at, c.ended_at,
              (c.caller_id = $1) AS outgoing,
              p.id AS peer_id, p.handle AS peer_handle, p.display_name AS peer_name, p.avatar_url AS peer_avatar
         FROM call_logs c
         JOIN users p ON p.id = CASE WHEN c.caller_id = $1 THEN c.callee_id ELSE c.caller_id END
        WHERE (c.caller_id = $1 AND NOT c.hidden_by_caller) OR (c.callee_id = $1 AND NOT c.hidden_by_callee)
        ORDER BY c.started_at DESC LIMIT 100`,
      [req.user.id],
    );
    res.json({
      calls: r.rows.map((c) => ({
        id: c.id,
        chatId: c.chat_id,
        callType: c.call_type,
        direction: c.outgoing ? 'OUTGOING' : 'INCOMING',
        // MISSED: arayan için "yanıtlanmadı", aranan için "cevapsız"
        status: c.status,
        startedAt: c.started_at,
        durationSeconds: c.answered_at && c.ended_at ? Math.max(0, Math.round((new Date(c.ended_at) - new Date(c.answered_at)) / 1000)) : null,
        peer: { id: c.peer_id, handle: c.peer_handle, displayName: c.peer_name, avatarUrl: c.peer_avatar },
      })),
    });
  } catch (err) {
    console.error('list calls error', err);
    res.status(500).json({ error: 'Arama geçmişi alınamadı.' });
  }
});

const hideSql = (all) => `UPDATE call_logs SET
    hidden_by_caller = CASE WHEN caller_id = $1 THEN true ELSE hidden_by_caller END,
    hidden_by_callee = CASE WHEN callee_id = $1 THEN true ELSE hidden_by_callee END
  WHERE (caller_id = $1 OR callee_id = $1)${all ? '' : ' AND id = $2'}`;

// DELETE /api/calls — geçmişimi temizle (karşı tarafın kaydı etkilenmez)
router.delete('/', async (req, res) => {
  try {
    await pool.query(hideSql(true), [req.user.id]);
    res.status(204).send();
  } catch (err) {
    console.error('clear calls error', err);
    res.status(500).json({ error: 'Temizlenemedi.' });
  }
});

// DELETE /api/calls/:id
router.delete('/:id', [param('id').isUUID()], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz id.' });
  try {
    await pool.query(hideSql(false), [req.user.id, req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error('delete call error', err);
    res.status(500).json({ error: 'Silinemedi.' });
  }
});

module.exports = router;
