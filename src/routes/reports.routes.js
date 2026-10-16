const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Şikayet nedenleri (istemcideki liste ile aynı).
const REASONS = ['SPAM', 'HARASSMENT', 'HATE', 'SEXUAL', 'VIOLENCE', 'FAKE', 'OTHER'];
// Bir kullanıcının saatte yapabileceği en fazla şikayet (kötüye kullanıma karşı).
const MAX_REPORTS_PER_HOUR = 10;
// Kanıt olarak saklanan medya üst sınırı (mesaj medyası zaten en fazla 20 MB).
const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
const E2E_PREFIX = 'sipchat-e2e-v1:';

// POST /api/reports
// { targetUserId, reason, details?, chatId?, messageId?, evidenceText?, alsoBlock? }
//  - Şikayet edilen kişiyle en az bir ortak sohbetiniz olmalı.
//  - messageId verilirse mesajın anlık görüntüsü (tür, zaman, düz metin ya da medya) kanıt olarak saklanır; mesaj
//    sonradan silinse bile moderatör görebilir. Birebir sohbetlerin metni uçtan uca şifreli olduğundan sunucu
//    okuyamaz: istemci, şikayet eden kişinin onayıyla çözülmüş metni "evidenceText" olarak ekleyebilir
//    (doğrulanamadığı için "reporterProvidedText" diye işaretlenir).
router.post(
  '/',
  [
    body('targetUserId').isUUID(),
    body('reason').isIn(REASONS),
    body('details').optional({ nullable: true }).isString().isLength({ max: 1000 }),
    body('chatId').optional({ nullable: true }).isUUID(),
    body('messageId').optional({ nullable: true }).isUUID(),
    body('evidenceText').optional({ nullable: true }).isString().isLength({ max: 2000 }),
    body('alsoBlock').optional().isBoolean(),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz istek.' });
    const me = req.user.id;
    const { targetUserId, reason, details, chatId, messageId, evidenceText } = req.body;
    if (targetUserId === me) return res.status(400).json({ error: 'Kendinizi şikayet edemezsiniz.' });

    try {
      const recent = await pool.query(
        "SELECT COUNT(*)::int AS n FROM reports WHERE reporter_id = $1 AND created_at > now() - interval '1 hour'",
        [me],
      );
      if (recent.rows[0].n >= MAX_REPORTS_PER_HOUR) {
        return res.status(429).json({ error: 'Çok fazla şikayet gönderdiniz. Bir süre sonra tekrar deneyin.' });
      }

      const shared = await pool.query(
        `SELECT a.chat_id FROM chat_members a JOIN chat_members b ON a.chat_id = b.chat_id
          WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1`,
        [me, targetUserId],
      );
      if (shared.rows.length === 0) return res.status(403).json({ error: 'Yalnızca sohbet ettiğiniz kişileri şikayet edebilirsiniz.' });

      let snapshot = null;
      let evidenceMedia = null;
      let evidenceMime = null;
      let reportChatId = chatId || null;

      if (messageId) {
        const m = await pool.query(
          `SELECT m.id, m.chat_id, m.sender_id, m.type, m.text, m.created_at, m.media_mime, m.media_filename, m.media_data
             FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
            WHERE m.id = $1`,
          [messageId, me],
        );
        const msg = m.rows[0];
        if (!msg || msg.sender_id !== targetUserId) {
          return res.status(404).json({ error: 'Şikayet edilen mesaj bulunamadı.' });
        }
        reportChatId = msg.chat_id;
        const encrypted = typeof msg.text === 'string' && msg.text.startsWith(E2E_PREFIX);
        snapshot = {
          type: msg.type,
          sentAt: msg.created_at,
          // Sunucunun okuyabildiği (şifresiz) metin; E2E ise yalnızca şifreli olduğu belirtilir.
          text: encrypted || msg.type === 'VOICE' ? null : msg.text,
          encrypted,
          mediaMime: msg.media_mime || null,
          mediaFilename: msg.media_filename || null,
          hasMedia: !!msg.media_data,
        };
        if (encrypted && evidenceText) snapshot.reporterProvidedText = evidenceText;
        if (msg.media_data && msg.media_data.length <= MAX_EVIDENCE_BYTES) {
          evidenceMedia = msg.media_data;
          evidenceMime = msg.media_mime || 'application/octet-stream';
        }
      } else if (chatId) {
        const ok = await pool.query(
          `SELECT 1 FROM chat_members a JOIN chat_members b ON a.chat_id = b.chat_id
            WHERE a.chat_id = $3 AND a.user_id = $1 AND b.user_id = $2`,
          [me, targetUserId, chatId],
        );
        if (ok.rows.length === 0) return res.status(403).json({ error: 'Bu sohbet için yetkiniz yok.' });
      } else {
        reportChatId = shared.rows[0].chat_id;
      }

      // Aynı kişi aynı hedefi/mesajı tekrar şikayet ederse yeni kayıt açılmaz.
      const dup = await pool.query(
        `SELECT id FROM reports
          WHERE reporter_id = $1 AND target_user_id = $2 AND status = 'OPEN'
            AND message_id IS NOT DISTINCT FROM $3::uuid LIMIT 1`,
        [me, targetUserId, messageId || null],
      );
      let id;
      if (dup.rows.length > 0) {
        id = dup.rows[0].id;
      } else {
        const ins = await pool.query(
          `INSERT INTO reports (reporter_id, target_user_id, chat_id, message_id, reason, details, snapshot, evidence_media, evidence_mime)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [me, targetUserId, reportChatId, messageId || null, reason, details || null,
            snapshot ? JSON.stringify(snapshot) : null, evidenceMedia, evidenceMime],
        );
        id = ins.rows[0].id;
      }

      if (req.body.alsoBlock === true) {
        await pool.query(
          'INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT (blocker_id, blocked_id) DO NOTHING',
          [me, targetUserId],
        );
      }
      return res.status(201).json({ id });
    } catch (err) {
      console.error('report error', err);
      return res.status(500).json({ error: 'Şikayet gönderilemedi.' });
    }
  },
);

module.exports = router;
