const express = require('express');
const multer = require('multer');
const { body, param, query, validationResult } = require('express-validator');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const { hashEmail, normalize, isEmail } = require('../emailhash');

const router = express.Router();
router.use(requireAuth);

// Profile photos: the client downsizes to ~512px JPEG first; 2 MB is a hard
// server-side ceiling regardless.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AVATAR_BYTES } });

/** Detects the real image type from magic bytes (the client-supplied MIME is not trusted). */
function sniffImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

const toPublicUser = (u) => ({ id: u.id, handle: u.handle, displayName: u.display_name, avatarUrl: u.avatar_url });

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

// ---------------------------------------------------------------------------
// E-posta eşleştirme ("karşılıklı eşleşme"): iki kişi ancak İKİSİ DE birbirinin doğrulanmış
// e-postasını listesine eklediyse ve ikisi de eşleştirmeye katıldıysa birbirini bulur. Sunucu
// yalnızca anahtarlı özetleri saklar; tek taraflı eşleşmeler kimseye gösterilmez (hesap keşfi yok).
// ---------------------------------------------------------------------------
const MAX_KNOWN_EMAILS = 500;
const knownEmailsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `known:${req.user?.id || req.ip}`,
  message: { error: 'Çok sık güncellediniz, bir saat sonra tekrar deneyin.' },
});

// GET /api/users/me/email
router.get('/me/email', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.email, u.email_verified, u.google_sub IS NOT NULL AS google_linked, u.email_matching_enabled, u.has_password,
              (SELECT COUNT(*)::int FROM contact_hashes c WHERE c.user_id = u.id) AS known_count
         FROM users u WHERE u.id = $1`,
      [req.user.id],
    );
    const u = r.rows[0];
    res.json({
      email: u.email, verified: u.email_verified, googleLinked: u.google_linked,
      matchingEnabled: u.email_matching_enabled, knownCount: u.known_count, hasPassword: u.has_password,
    });
  } catch (err) {
    console.error('get email status error', err);
    res.status(500).json({ error: 'E-posta bilgisi alınamadı.' });
  }
});

// PATCH /api/users/me/email-matching {enabled} — varsayılan kapalı; doğrulanmış e-posta gerekir.
router.patch('/me/email-matching', [body('enabled').isBoolean()], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz değer.' });
  try {
    const enabled = req.body.enabled === true || req.body.enabled === 'true';
    const r = await pool.query(
      'UPDATE users SET email_matching_enabled = $2 WHERE id = $1 AND ($2 = false OR email_verified) RETURNING email_matching_enabled',
      [req.user.id, enabled],
    );
    if (r.rows.length === 0) return res.status(400).json({ error: 'Önce Google hesabınızı bağlayıp e-postanızı doğrulayın.' });
    res.json({ matchingEnabled: r.rows[0].email_matching_enabled });
  } catch (err) {
    console.error('email matching toggle error', err);
    res.status(500).json({ error: 'Ayar kaydedilemedi.' });
  }
});

// PUT /api/users/me/known-emails {emails: [...]} — "tanıdığım e-postalar" listemi değiştirir.
router.put('/me/known-emails', knownEmailsLimiter, [body('emails').isArray({ max: MAX_KNOWN_EMAILS })], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: `En fazla ${MAX_KNOWN_EMAILS} e-posta.` });
  const emails = [...new Set(req.body.emails.map(normalize).filter(isEmail))];
  const client = await pool.connect();
  try {
    const own = await pool.query('SELECT email_hash FROM users WHERE id = $1', [req.user.id]);
    const ownHash = own.rows[0]?.email_hash;
    const hashes = [...new Set(emails.map(hashEmail))].filter((h) => h !== ownHash);
    await client.query('BEGIN');
    await client.query('DELETE FROM contact_hashes WHERE user_id = $1', [req.user.id]);
    if (hashes.length) {
      await client.query('INSERT INTO contact_hashes (user_id, hash) SELECT $1, unnest($2::text[])', [req.user.id, hashes]);
    }
    await client.query('COMMIT');
    res.json({ count: hashes.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('known emails error', err);
    res.status(500).json({ error: 'Liste kaydedilemedi.' });
  } finally {
    client.release();
  }
});

// GET /api/users/matches — yalnızca KARŞILIKLI eşleşenler.
router.get('/matches', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.handle, u.display_name, u.avatar_url
         FROM users me
         JOIN contact_hashes mine ON mine.user_id = me.id
         JOIN users u ON u.email_hash = mine.hash AND u.id <> me.id
        WHERE me.id = $1
          AND me.email_matching_enabled AND me.email_verified AND me.email_hash IS NOT NULL
          AND u.email_matching_enabled AND u.email_verified
          AND EXISTS (SELECT 1 FROM contact_hashes theirs WHERE theirs.user_id = u.id AND theirs.hash = me.email_hash)
          AND NOT EXISTS (SELECT 1 FROM blocked_users b
                           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))
        ORDER BY u.display_name`,
      [req.user.id],
    );
    res.json({ matches: r.rows.map((u) => ({ id: u.id, handle: u.handle, displayName: u.display_name, avatarUrl: u.avatar_url })) });
  } catch (err) {
    console.error('matches error', err);
    res.status(500).json({ error: 'Eşleşmeler alınamadı.' });
  }
});

// PUT /api/users/me/avatar — multipart field "file" (JPEG/PNG/WebP, ≤ 2 MB).
// avatar_url becomes an absolute URL to GET /api/users/:id/avatar with a
// cache-busting ?v= so every client refreshes the picture immediately.
router.put('/me/avatar', (req, res, next) => {
  avatarUpload.single('file')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'Fotoğraf en fazla 2 MB olabilir.' : 'Yükleme başarısız.' });
    }
    return next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya eksik (multipart alan adı: "file").' });
  const mime = sniffImageMime(req.file.buffer);
  if (!mime) return res.status(400).json({ error: 'Yalnızca JPEG, PNG veya WebP yüklenebilir.' });
  try {
    const url = `${req.protocol}://${req.get('host')}/api/users/${req.user.id}/avatar?v=${Date.now()}`;
    const r = await pool.query(
      `UPDATE users SET avatar_data = $2, avatar_mime = $3, avatar_url = $4
        WHERE id = $1 RETURNING id, handle, display_name, avatar_url`,
      [req.user.id, req.file.buffer, mime, url],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    res.json({ user: toPublicUser(r.rows[0]) });
  } catch (err) {
    console.error('put avatar error', err);
    res.status(500).json({ error: 'Fotoğraf kaydedilemedi.' });
  }
});

// DELETE /api/users/me/avatar — back to no picture.
router.delete('/me/avatar', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE users SET avatar_data = NULL, avatar_mime = NULL, avatar_url = NULL
        WHERE id = $1 RETURNING id, handle, display_name, avatar_url`,
      [req.user.id],
    );
    res.json({ user: toPublicUser(r.rows[0]) });
  } catch (err) {
    console.error('delete avatar error', err);
    res.status(500).json({ error: 'Fotoğraf kaldırılamadı.' });
  }
});

// GET /api/users/:userId/avatar — any signed-in user may view any profile photo.
router.get('/:userId/avatar', [param('userId').isUUID()], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz kullanıcı.' });
  try {
    const r = await pool.query('SELECT avatar_data, avatar_mime FROM users WHERE id = $1', [req.params.userId]);
    if (r.rows.length === 0 || !r.rows[0].avatar_data) return res.status(404).json({ error: 'Fotoğraf yok.' });
    res.setHeader('Content-Type', r.rows[0].avatar_mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(r.rows[0].avatar_data);
  } catch (err) {
    console.error('get avatar error', err);
    res.status(500).json({ error: 'Fotoğraf getirilemedi.' });
  }
});

// E-posta ile arama hesap keşfine yol açmasın diye: yalnızca TAM adres eşleşmesi, yalnızca doğrulanmış e-postası
// olan ve "e-posta ile bulunabilirlik/eşleştirme"yi kendisi açmış kişiler, ve kullanıcı başına saatte 30 sorgu.
const emailSearchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `emailsearch:${req.user?.id || req.ip}`,
  message: { error: 'Çok fazla e-posta araması yaptınız, bir saat sonra tekrar deneyin.' },
});

// GET /api/users/search?q=... — yeni kişi bul: kullanıcı adı / görünen ad (en az 2 karakter) YA DA tam e-posta adresi.
// Kendimi ve beni engelleyen/engellediğim kişileri asla döndürmez.
router.get('/search', [query('q').isString().trim().isLength({ min: 2, max: 100 })], async (req, res, next) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'En az 2 karakter girin.' });
  const q = req.query.q.trim();
  if (q.includes('@') && isEmail(normalize(q))) return emailSearchLimiter(req, res, () => emailSearch(req, res));
  return next();
}, async (req, res) => {
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

async function emailSearch(req, res) {
  try {
    const hash = hashEmail(normalize(req.query.q.trim()));
    const r = await pool.query(
      `SELECT id, handle, display_name, avatar_url FROM users
        WHERE id != $1 AND email_hash = $2 AND email_verified AND email_matching_enabled
          AND id NOT IN (
            SELECT blocked_id FROM blocked_users WHERE blocker_id = $1
            UNION
            SELECT blocker_id FROM blocked_users WHERE blocked_id = $1
          )
        LIMIT 5`,
      [req.user.id, hash],
    );
    res.json({ users: r.rows.map((u) => ({ id: u.id, handle: u.handle, displayName: u.display_name, avatarUrl: u.avatar_url })) });
  } catch (err) {
    console.error('email search error', err);
    res.status(500).json({ error: 'Arama başarısız.' });
  }
}

// ---------------------------------------------------------------------------
// Kişiler (rehber): "Yeni sohbet" ekranında listelenir. Elle eklenir/çıkarılır; birebir sohbette ilk mesajlaşılan
// kişiler otomatik eklenir (realtime.addContactsOnFirstMessage).
// ---------------------------------------------------------------------------
// GET /api/users/contacts
router.get('/contacts', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.handle, u.display_name, u.avatar_url
         FROM contacts c JOIN users u ON u.id = c.contact_id
        WHERE c.owner_id = $1
          AND u.id NOT IN (
            SELECT blocked_id FROM blocked_users WHERE blocker_id = $1
            UNION
            SELECT blocker_id FROM blocked_users WHERE blocked_id = $1
          )
        ORDER BY lower(u.display_name), u.handle`,
      [req.user.id],
    );
    res.json({ users: r.rows.map((u) => ({ id: u.id, handle: u.handle, displayName: u.display_name, avatarUrl: u.avatar_url })) });
  } catch (err) {
    console.error('list contacts error', err);
    res.status(500).json({ error: 'Kişiler alınamadı.' });
  }
});

// PUT /api/users/contacts/:userId — kişilerime ekle
router.put('/contacts/:userId', [param('userId').isUUID()], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz kullanıcı.' });
  if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Kendinizi ekleyemezsiniz.' });
  try {
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM contacts WHERE owner_id = $1', [req.user.id]);
    if (count.rows[0].n >= 2000) return res.status(400).json({ error: 'Kişi listesi dolu (en fazla 2000).' });
    const ok = await pool.query(
      `SELECT 1 FROM users WHERE id = $2 AND $2 NOT IN (
         SELECT blocked_id FROM blocked_users WHERE blocker_id = $1
         UNION SELECT blocker_id FROM blocked_users WHERE blocked_id = $1)`,
      [req.user.id, req.params.userId],
    );
    if (ok.rows.length === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    await pool.query('INSERT INTO contacts (owner_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, req.params.userId]);
    res.status(204).send();
  } catch (err) {
    console.error('add contact error', err);
    res.status(500).json({ error: 'Kişi eklenemedi.' });
  }
});

// DELETE /api/users/contacts/:userId — kişilerimden çıkar (sohbet ve mesajlar etkilenmez)
router.delete('/contacts/:userId', [param('userId').isUUID()], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz kullanıcı.' });
  try {
    await pool.query('DELETE FROM contacts WHERE owner_id = $1 AND contact_id = $2', [req.user.id, req.params.userId]);
    res.status(204).send();
  } catch (err) {
    console.error('remove contact error', err);
    res.status(500).json({ error: 'Kişi çıkarılamadı.' });
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

