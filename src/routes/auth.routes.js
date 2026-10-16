const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { signToken, verifyToken } = require('../utils/jwt');
const { requireAuth } = require('../middleware/auth');
const totp = require('../totp');
const twofactor = require('../twofactor');
const adminOps = require('../admin');
const google = require('../google');
const crypto = require('crypto');
const { hashEmail } = require('../emailhash');
const recovery = require('../recovery');

const router = express.Router();

const HANDLE_REGEX = /^[a-z0-9_]{3,20}$/;

function toPublicUser(row) {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}

/** Creates a `sessions` row and returns a JWT whose "sid" claim points to it. */
async function createSession(userId, handle, deviceName) {
  const session = await pool.query(
    `INSERT INTO sessions (user_id, device_name) VALUES ($1, $2) RETURNING id`,
    [userId, (deviceName || 'Bilinmeyen cihaz').slice(0, 120)],
  );
  const sid = session.rows[0].id;
  const token = signToken({ sub: userId, handle, sid });
  return { token, sid };
}

router.post(
  '/register',
  [
    body('handle')
      .trim()
      .toLowerCase()
      .matches(HANDLE_REGEX)
      .withMessage('handle 3-20 karakter, küçük harf/rakam/alt çizgi olmalı'),
    body('displayName').trim().isLength({ min: 1, max: 60 }),
    body('password').isLength({ min: 8, max: 128 }).withMessage('Şifre en az 8 karakter olmalı'),
    body('deviceName').optional().isString().isLength({ max: 120 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { handle, displayName, password, deviceName } = req.body;

    try {
      const existing = await pool.query('SELECT id FROM users WHERE handle = $1', [handle]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Bu kullanıcı adı zaten alınmış.' });
      }

      // Cost factor 12: a deliberate, industry-standard slowdown against
      // brute-force/offline password cracking.
      const passwordHash = await bcrypt.hash(password, 12);

      const result = await pool.query(
        `INSERT INTO users (handle, display_name, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, handle, display_name, avatar_url`,
        [handle, displayName, passwordHash],
      );
      const user = result.rows[0];

      // Every user gets a settings row up front so every later query that
      // joins user_settings (read receipts, last-seen privacy, etc.) can
      // assume it always exists — no scattered "row might not exist" checks.
      await pool.query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);

      // Parola sıfırlama için kurtarma anahtarı: yalnızca burada (ve Ayarlar'dan yenilenince) düz hâliyle gösterilir.
      const recoveryKey = await recovery.issueKey(user.id);

      const { token } = await createSession(user.id, user.handle, deviceName);
      return res.status(201).json({ token, user: toPublicUser(user), recoveryKey });
    } catch (err) {
      console.error('register error', err);
      return res.status(500).json({ error: 'Kayıt sırasında bir hata oluştu.' });
    }
  },
);

router.post(
  '/login',
  [
    body('handle').trim().toLowerCase().notEmpty(),
    body('password').notEmpty(),
    body('deviceName').optional().isString().isLength({ max: 120 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'handle ve password zorunludur.' });
    }

    const { handle, password, deviceName } = req.body;

    try {
      const result = await pool.query(
        `SELECT u.id, u.handle, u.display_name, u.avatar_url, u.password_hash,
                COALESCE(s.two_factor_enabled, false) AS two_factor_enabled
           FROM users u
           LEFT JOIN user_settings s ON s.user_id = u.id
          WHERE u.handle = $1`,
        [handle],
      );

      // Same generic error whether the handle doesn't exist or the password
      // is wrong — do not leak which case it was.
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
      }

      const user = result.rows[0];
      const matches = await bcrypt.compare(password, user.password_hash);
      if (!matches) {
        return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
      }

      if (user.two_factor_enabled) {
        // Short-lived, single-purpose token: only /auth/2fa/verify-login
        // will accept it, and only for 5 minutes.
        const pendingToken = signToken({ sub: user.id, handle: user.handle, purpose: '2fa_pending' }, '5m');
        return res.json({ requiresTwoFactor: true, pendingToken });
      }

      const { token } = await createSession(user.id, user.handle, deviceName);
      return res.json({ token, user: toPublicUser(user) });
    } catch (err) {
      console.error('login error', err);
      return res.status(500).json({ error: 'Giriş sırasında bir hata oluştu.' });
    }
  },
);

// POST /api/auth/2fa/verify-login — second step of login when 2FA is on.
// "code" is either the 6-digit authenticator code OR one of the one-time
// backup codes (XXXXX-XXXXX) — that is the recovery path for someone who
// lost their authenticator app.
router.post(
  '/2fa/verify-login',
  [body('pendingToken').isString().notEmpty(), body('code').isString().isLength({ min: 6, max: 16 })],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz istek.' });

    let payload;
    try {
      payload = verifyToken(req.body.pendingToken);
    } catch (err) {
      return res.status(401).json({ error: 'Oturum süresi doldu, tekrar giriş yapın.' });
    }
    if (payload.purpose !== '2fa_pending') {
      return res.status(401).json({ error: 'Geçersiz token.' });
    }

    try {
      const result = await pool.query(
        `SELECT u.id, u.handle, u.display_name, u.avatar_url, s.two_factor_secret
           FROM users u JOIN user_settings s ON s.user_id = u.id
          WHERE u.id = $1`,
        [payload.sub],
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

      const user = result.rows[0];
      const check = await twofactor.verifySecondFactor(user.id, user.two_factor_secret, req.body.code);
      if (!check.ok) {
        if (check.locked) {
          return res.status(429).json({ error: `Çok fazla hatalı deneme. ${check.retryAfterMin} dakika sonra tekrar deneyin.` });
        }
        return res.status(401).json({ error: 'Kod hatalı veya süresi dolmuş.' });
      }

      const { token } = await createSession(user.id, user.handle, req.body.deviceName);
      const response = { token, user: toPublicUser(user) };
      if (check.via === 'backup') {
        response.usedBackupCode = true;
        response.backupCodesRemaining = await twofactor.countRemainingBackupCodes(user.id);
      }
      return res.json(response);
    } catch (err) {
      console.error('2fa verify-login error', err);
      return res.status(500).json({ error: 'Doğrulama başarısız.' });
    }
  },
);

// GET /api/auth/me — the authenticated caller's own profile.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, handle, display_name, avatar_url FROM users WHERE id = $1',
      [req.user.id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    res.json({ user: toPublicUser(result.rows[0]) });
  } catch (err) {
    console.error('me error', err);
    res.status(500).json({ error: 'Profil getirilemedi.' });
  }
});

// --- Two-factor authentication management (requires an existing session) ---

// ---------------------------------------------------------------------------
// Google ile giriş / kayıt
// ---------------------------------------------------------------------------

// GET /api/auth/config — istemci hangi giriş yöntemlerinin açık olduğunu buradan öğrenir.
router.get('/config', (req, res) => {
  const ids = google.clientIds();
  res.json({ googleEnabled: ids.length > 0, googleClientId: ids[0] || null });
});

function suggestHandle(email, name) {
  const base = String(email || name || 'kullanici').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
  const trimmed = (base.length >= 3 ? base : `${base}user`).slice(0, 16);
  return trimmed.length >= 3 ? trimmed : 'kullanici';
}

// POST /api/auth/google {idToken, handle?, displayName?, deviceName?}
//  - bu Google hesabı daha önce bağlanmışsa: giriş (2FA açıksa ikinci adım istenir)
//  - yeni hesapsa ve handle yoksa: {needsHandle:true, suggestedHandle, email, displayName}
//  - yeni hesapsa ve handle varsa: hesabı oluşturur (parola yok; yalnızca Google ile girilir)
router.post(
  '/google',
  [
    body('idToken').isString().isLength({ min: 10, max: 5000 }),
    body('handle').optional().trim().toLowerCase().matches(HANDLE_REGEX),
    body('displayName').optional().trim().isLength({ min: 1, max: 60 }),
    body('deviceName').optional().isString().isLength({ max: 120 }),
  ],
  async (req, res) => {
    if (!google.enabled()) return res.status(404).json({ error: 'Google ile giriş yapılandırılmamış.' });
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz istek.' });

    let g;
    try {
      g = await google.verifyIdToken(req.body.idToken);
    } catch (err) {
      return res.status(401).json({ error: 'Google doğrulaması başarısız.' });
    }
    if (!g?.sub || !g.email || g.email_verified !== true) {
      return res.status(400).json({ error: 'Google e-posta adresiniz doğrulanmamış.' });
    }

    try {
      const existing = await pool.query(
        `SELECT u.id, u.handle, u.display_name, u.avatar_url, COALESCE(s.two_factor_enabled, false) AS two_factor_enabled
           FROM users u LEFT JOIN user_settings s ON s.user_id = u.id WHERE u.google_sub = $1`,
        [g.sub],
      );
      if (existing.rows.length > 0) {
        const user = existing.rows[0];
        if (user.two_factor_enabled) {
          const pendingToken = signToken({ sub: user.id, handle: user.handle, purpose: '2fa_pending' }, '5m');
          return res.json({ requiresTwoFactor: true, pendingToken });
        }
        const { token } = await createSession(user.id, user.handle, req.body.deviceName);
        return res.json({ token, user: toPublicUser(user) });
      }

      const emailTaken = await pool.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [g.email]);
      if (emailTaken.rows.length > 0) {
        return res.status(409).json({ error: 'Bu e-posta başka bir hesaba bağlı. O hesapla giriş yapıp Ayarlar\'dan Google\'ı bağlayın.' });
      }

      const handle = req.body.handle;
      if (!handle) {
        let suggested = suggestHandle(g.email, g.name);
        const clash = await pool.query('SELECT 1 FROM users WHERE handle = $1', [suggested]);
        if (clash.rows.length > 0) suggested = `${suggested.slice(0, 14)}${Math.floor(10 + Math.random() * 89)}`;
        return res.json({ needsHandle: true, suggestedHandle: suggested, email: g.email, displayName: g.name || suggested });
      }

      const taken = await pool.query('SELECT 1 FROM users WHERE handle = $1', [handle]);
      if (taken.rows.length > 0) return res.status(409).json({ error: 'Bu kullanıcı adı zaten alınmış.' });

      const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const displayName = (req.body.displayName || g.name || handle).slice(0, 60);
      const created = await pool.query(
        `INSERT INTO users (handle, display_name, password_hash, email, email_verified, google_sub, email_hash, has_password)
         VALUES ($1, $2, $3, $4, true, $5, $6, false) RETURNING id, handle, display_name, avatar_url`,
        [handle, displayName, randomHash, g.email.toLowerCase(), g.sub, hashEmail(g.email)],
      );
      const user = created.rows[0];
      await pool.query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);
      const { token } = await createSession(user.id, user.handle, req.body.deviceName);
      return res.status(201).json({ token, user: toPublicUser(user) });
    } catch (err) {
      console.error('google auth error', err);
      return res.status(500).json({ error: 'Google ile giriş sırasında bir hata oluştu.' });
    }
  },
);

// POST /api/auth/google/link {idToken} — mevcut hesaba Google'ı (ve doğrulanmış e-postayı) bağlar.
router.post('/google/link', requireAuth, [body('idToken').isString().isLength({ min: 10, max: 5000 })], async (req, res) => {
  if (!google.enabled()) return res.status(404).json({ error: 'Google ile giriş yapılandırılmamış.' });
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz istek.' });
  let g;
  try {
    g = await google.verifyIdToken(req.body.idToken);
  } catch (err) {
    return res.status(401).json({ error: 'Google doğrulaması başarısız.' });
  }
  if (!g?.sub || !g.email || g.email_verified !== true) {
    return res.status(400).json({ error: 'Google e-posta adresiniz doğrulanmamış.' });
  }
  try {
    const clash = await pool.query(
      'SELECT id FROM users WHERE (google_sub = $1 OR lower(email) = lower($2)) AND id <> $3',
      [g.sub, g.email, req.user.id],
    );
    if (clash.rows.length > 0) return res.status(409).json({ error: 'Bu Google hesabı başka bir SipChat hesabına bağlı.' });
    await pool.query(
      'UPDATE users SET google_sub = $2, email = $3, email_verified = true, email_hash = $4 WHERE id = $1',
      [req.user.id, g.sub, g.email.toLowerCase(), hashEmail(g.email)],
    );
    return res.json({ email: g.email.toLowerCase() });
  } catch (err) {
    console.error('google link error', err);
    return res.status(500).json({ error: 'Google hesabı bağlanamadı.' });
  }
});

// ---------------------------------------------------------------------------
// Parola sıfırlama / hesap kurtarma (ücretsiz, e-posta ya da SMS gerektirmez)
// ---------------------------------------------------------------------------

/** Tüm oturumları sonlandırır (parola değişince eski cihazlar çıkış yapar). */
async function revokeAllSessions(userId) {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

/** 2FA açıksa ikinci faktörü doğrular. Dönüş: null (sorun yok) ya da { status, body }. */
async function requireSecondFactorIfEnabled(userId, code) {
  const s = await pool.query('SELECT two_factor_enabled, two_factor_secret FROM user_settings WHERE user_id = $1', [userId]);
  const row = s.rows[0];
  if (!row?.two_factor_enabled) return null;
  if (!code) {
    return { status: 401, body: { error: 'İki aşamalı doğrulama kodu (ya da yedek kod) gerekli.', requiresTwoFactor: true } };
  }
  const check = await twofactor.verifySecondFactor(userId, row.two_factor_secret, code);
  if (check.ok) return null;
  if (check.locked) return { status: 429, body: { error: `Çok fazla hatalı deneme. ${check.retryAfterMin} dakika sonra tekrar deneyin.` } };
  return { status: 401, body: { error: 'Doğrulama kodu hatalı.', requiresTwoFactor: true } };
}

// GET /api/auth/recovery-key/status — bu hesabın bir kurtarma anahtarı var mı?
router.get('/recovery-key/status', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT recovery_hash IS NOT NULL AS exists, recovery_created_at, has_password, google_sub IS NOT NULL AS google_linked FROM users WHERE id = $1', [req.user.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Hesap bulunamadı.' });
    return res.json({
      exists: r.rows[0].exists,
      createdAt: r.rows[0].recovery_created_at,
      hasPassword: r.rows[0].has_password,
      googleLinked: r.rows[0].google_linked,
    });
  } catch (err) {
    console.error('recovery status error', err);
    return res.status(500).json({ error: 'Durum alınamadı.' });
  }
});

// POST /api/auth/recovery-key {password | idToken, code?} — yeni kurtarma anahtarı üretir (eskisi geçersiz olur).
// Çalınmış bir oturumun hesabı ele geçirmesini önlemek için parola (Google hesaplarında taze Google doğrulaması)
// ve 2FA açıksa kod ister.
router.post(
  '/recovery-key',
  requireAuth,
  [
    body('password').optional().isString().isLength({ max: 200 }),
    body('idToken').optional().isString().isLength({ max: 5000 }),
    body('code').optional().isString().isLength({ max: 16 }),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz istek.' });
    if (!req.body.password && !req.body.idToken) return res.status(400).json({ error: 'Parola ya da Google doğrulaması gerekli.' });
    try {
      const u = await pool.query('SELECT password_hash, google_sub, has_password FROM users WHERE id = $1', [req.user.id]);
      const row = u.rows[0];
      if (!row) return res.status(404).json({ error: 'Hesap bulunamadı.' });
      if (req.body.idToken) {
        if (!google.enabled() || !row.google_sub) return res.status(403).json({ error: 'Bu hesap Google ile doğrulanamıyor.' });
        let g;
        try {
          g = await google.verifyIdToken(req.body.idToken);
        } catch (err) {
          return res.status(403).json({ error: 'Google doğrulaması başarısız.' });
        }
        if (g?.sub !== row.google_sub) return res.status(403).json({ error: 'Bu Google hesabı SipChat hesabınızla eşleşmiyor.' });
      } else if (!row.has_password) {
        return res.status(403).json({ error: 'Bu hesap Google ile açıldı; Google ile doğrulayın.' });
      } else if (!(await bcrypt.compare(req.body.password, row.password_hash))) {
        return res.status(403).json({ error: 'Parola hatalı.' });
      }
      const blocked = await requireSecondFactorIfEnabled(req.user.id, req.body.code);
      if (blocked) return res.status(blocked.status === 401 ? 403 : blocked.status).json(blocked.body);

      const recoveryKey = await recovery.issueKey(req.user.id);
      return res.json({ recoveryKey });
    } catch (err) {
      console.error('recovery key error', err);
      return res.status(500).json({ error: 'Kurtarma anahtarı oluşturulamadı.' });
    }
  },
);

// POST /api/auth/reset-password {handle, recoveryKey, newPassword, code?}
// Oturum gerekmez. Başarılı olunca parola değişir, TÜM oturumlar kapatılır, kurtarma anahtarı yenilenir
// (yeni anahtar yanıtta döner) ve 2FA açıksa kod da istenir. Hatalı denemeler hesap bazında kilitlenir.
router.post(
  '/reset-password',
  [
    body('handle').trim().toLowerCase().matches(HANDLE_REGEX),
    body('recoveryKey').isString().isLength({ min: 10, max: 40 }),
    body('newPassword').isLength({ min: 8, max: 128 }).withMessage('Şifre en az 8 karakter olmalı'),
    body('code').optional().isString().isLength({ max: 16 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg || 'Geçersiz istek.' });
    const { handle, recoveryKey, newPassword, code } = req.body;
    const GENERIC = 'Kullanıcı adı veya kurtarma anahtarı hatalı.';
    try {
      const u = await pool.query('SELECT id, recovery_hash FROM users WHERE lower(handle) = $1', [handle]);
      const user = u.rows[0];
      if (!user || !user.recovery_hash) return res.status(401).json({ error: GENERIC });

      const left = await recovery.lockRemainingMs(user.id);
      if (left > 0) {
        return res.status(429).json({ error: `Çok fazla hatalı deneme. ${Math.ceil(left / 60000)} dakika sonra tekrar deneyin.` });
      }
      if (!recovery.keyMatches(user.recovery_hash, recoveryKey)) {
        await recovery.recordFailure(user.id);
        return res.status(401).json({ error: GENERIC });
      }

      const blocked = await requireSecondFactorIfEnabled(user.id, code);
      if (blocked) return res.status(blocked.status).json(blocked.body);

      await recovery.clearFailures(user.id);
      const hash = await bcrypt.hash(newPassword, 12);
      await pool.query('UPDATE users SET password_hash = $2, has_password = true WHERE id = $1', [user.id, hash]);
      await revokeAllSessions(user.id);
      const newKey = await recovery.issueKey(user.id);
      return res.json({ ok: true, recoveryKey: newKey });
    } catch (err) {
      console.error('reset password error', err);
      return res.status(500).json({ error: 'Parola sıfırlanamadı.' });
    }
  },
);

// POST /api/auth/reset-password/google {idToken, newPassword, code?} — Google'ı bağlı hesaplar için
// kurtarma anahtarı olmadan: taze Google doğrulaması parolayı yenilemeye yeter.
router.post(
  '/reset-password/google',
  [
    body('idToken').isString().isLength({ min: 10, max: 5000 }),
    body('newPassword').isLength({ min: 8, max: 128 }).withMessage('Şifre en az 8 karakter olmalı'),
    body('code').optional().isString().isLength({ max: 16 }),
  ],
  async (req, res) => {
    if (!google.enabled()) return res.status(404).json({ error: 'Google ile doğrulama yapılandırılmamış.' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg || 'Geçersiz istek.' });
    let g;
    try {
      g = await google.verifyIdToken(req.body.idToken);
    } catch (err) {
      return res.status(401).json({ error: 'Google doğrulaması başarısız.' });
    }
    if (!g?.sub || g.email_verified !== true) return res.status(400).json({ error: 'Google e-posta adresiniz doğrulanmamış.' });
    try {
      const u = await pool.query('SELECT id, handle FROM users WHERE google_sub = $1', [g.sub]);
      const user = u.rows[0];
      if (!user) return res.status(404).json({ error: 'Bu Google hesabına bağlı bir SipChat hesabı yok.' });

      const blocked = await requireSecondFactorIfEnabled(user.id, req.body.code);
      if (blocked) return res.status(blocked.status).json(blocked.body);

      const hash = await bcrypt.hash(req.body.newPassword, 12);
      await pool.query('UPDATE users SET password_hash = $2, has_password = true WHERE id = $1', [user.id, hash]);
      await revokeAllSessions(user.id);
      return res.json({ ok: true, handle: user.handle });
    } catch (err) {
      console.error('google reset password error', err);
      return res.status(500).json({ error: 'Parola sıfırlanamadı.' });
    }
  },
);

// DELETE /api/auth/me {password, code?} — permanently deletes the caller's own
// account (sessions, keys, memberships, their messages, backup…). Requires the
// password, and the 2FA/backup code when 2FA is on. Wrong credentials answer 403
// (not 401) so the app doesn't mistake it for an expired session.
router.delete(
  '/me',
  requireAuth,
  [body('password').optional().isString().isLength({ max: 200 }), body('idToken').optional().isString().isLength({ max: 5000 })],
  async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz istek.' });
  if (!req.body.password && !req.body.idToken) return res.status(400).json({ error: 'Parola ya da Google doğrulaması gerekli.' });
  try {
    const u = await pool.query(
      `SELECT u.password_hash, u.google_sub, u.has_password, s.two_factor_enabled, s.two_factor_secret
         FROM users u LEFT JOIN user_settings s ON s.user_id = u.id WHERE u.id = $1`,
      [req.user.id],
    );
    const row = u.rows[0];
    if (!row) return res.status(404).json({ error: 'Hesap bulunamadı.' });
    if (req.body.idToken) {
      // Google ile açılan (parolasız) hesaplar: taze bir Google doğrulaması, hesabın bağlı Google kimliğiyle eşleşmeli.
      if (!google.enabled() || !row.google_sub) return res.status(403).json({ error: 'Bu hesap Google ile doğrulanamıyor.' });
      let g;
      try {
        g = await google.verifyIdToken(req.body.idToken);
      } catch (err) {
        return res.status(403).json({ error: 'Google doğrulaması başarısız.' });
      }
      if (g?.sub !== row.google_sub) return res.status(403).json({ error: 'Bu Google hesabı SipChat hesabınızla eşleşmiyor.' });
    } else if (!row.has_password) {
      return res.status(403).json({ error: 'Bu hesap Google ile açıldı; Google ile doğrulayın.' });
    } else if (!(await bcrypt.compare(req.body.password, row.password_hash))) {
      return res.status(403).json({ error: 'Parola hatalı.' });
    }
    if (row.two_factor_enabled) {
      const check = await twofactor.verifySecondFactor(req.user.id, row.two_factor_secret, req.body.code);
      if (!check.ok) {
        if (check.locked) return res.status(429).json({ error: `Çok fazla hatalı deneme. ${check.retryAfterMin} dakika sonra tekrar deneyin.` });
        return res.status(403).json({ error: 'Doğrulama kodu hatalı.' });
      }
    }
    await adminOps.deleteUsers([req.user.id], req.app.get('io'));
    return res.status(204).send();
  } catch (err) {
    console.error('delete account error', err);
    return res.status(500).json({ error: 'Hesap silinemedi.' });
  }
  },
);

// POST /api/auth/2fa/setup — generates (or regenerates) a pending secret and
// returns it as both raw base32 and an otpauth:// URI (render as a QR code
// client-side). NOT yet enabled — call /2fa/enable with a code to confirm.
// Refused while 2FA is already on: otherwise any stolen session could quietly
// switch protection off just by calling setup again.
router.post('/2fa/setup', requireAuth, async (req, res) => {
  try {
    const current = await pool.query('SELECT two_factor_enabled FROM user_settings WHERE user_id = $1', [req.user.id]);
    if (current.rows[0]?.two_factor_enabled) {
      return res.status(409).json({ error: 'İki aşamalı doğrulama zaten açık. Önce kapatın.' });
    }
    const secret = totp.generateSecret();
    await pool.query(
      `INSERT INTO user_settings (user_id, two_factor_secret, two_factor_enabled)
       VALUES ($1, $2, false)
       ON CONFLICT (user_id) DO UPDATE SET two_factor_secret = EXCLUDED.two_factor_secret, two_factor_enabled = false`,
      [req.user.id, secret],
    );
    res.json({ secret, otpauthUri: totp.buildOtpAuthUri(req.user.handle, secret) });
  } catch (err) {
    console.error('2fa setup error', err);
    res.status(500).json({ error: 'Kurulum başlatılamadı.' });
  }
});

// POST /api/auth/2fa/enable {code} — confirms the pending secret from /setup
// and returns the one-time backup codes. They are shown exactly once.
router.post('/2fa/enable', requireAuth, [body('code').isString().isLength({ min: 6, max: 6 })], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz kod.' });
  try {
    const result = await pool.query('SELECT two_factor_secret, two_factor_enabled FROM user_settings WHERE user_id = $1', [req.user.id]);
    const row = result.rows[0];
    if (!row?.two_factor_secret) return res.status(400).json({ error: 'Önce /2fa/setup çağrılmalı.' });
    if (row.two_factor_enabled) return res.status(409).json({ error: 'İki aşamalı doğrulama zaten açık.' });
    if (!totp.verifyTotp(row.two_factor_secret, req.body.code)) return res.status(401).json({ error: 'Kod hatalı.' });

    await pool.query('UPDATE user_settings SET two_factor_enabled = true WHERE user_id = $1', [req.user.id]);
    const backupCodes = await twofactor.replaceBackupCodes(req.user.id);
    res.json({ backupCodes });
  } catch (err) {
    console.error('2fa enable error', err);
    res.status(500).json({ error: 'Etkinleştirilemedi.' });
  }
});

// POST /api/auth/2fa/disable {code} — requires a currently-valid TOTP code or
// an unused backup code, so a stolen session can't silently turn protection off.
router.post('/2fa/disable', requireAuth, [body('code').isString().isLength({ min: 6, max: 16 })], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz kod.' });
  try {
    const result = await pool.query('SELECT two_factor_secret FROM user_settings WHERE user_id = $1', [req.user.id]);
    const check = await twofactor.verifySecondFactor(req.user.id, result.rows[0]?.two_factor_secret, req.body.code);
    if (!check.ok) {
      if (check.locked) return res.status(429).json({ error: `Çok fazla hatalı deneme. ${check.retryAfterMin} dakika sonra tekrar deneyin.` });
      return res.status(401).json({ error: 'Kod hatalı.' });
    }

    await pool.query(
      'UPDATE user_settings SET two_factor_enabled = false, two_factor_secret = NULL WHERE user_id = $1',
      [req.user.id],
    );
    await pool.query('DELETE FROM two_factor_backup_codes WHERE user_id = $1', [req.user.id]);
    res.status(204).send();
  } catch (err) {
    console.error('2fa disable error', err);
    res.status(500).json({ error: 'Devre dışı bırakılamadı.' });
  }
});

// POST /api/auth/2fa/backup-codes/regenerate {code} — issues a fresh set of 10
// backup codes (invalidating all previous ones). Needs a valid TOTP/backup code.
router.post('/2fa/backup-codes/regenerate', requireAuth, [body('code').isString().isLength({ min: 6, max: 16 })], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Geçersiz kod.' });
  try {
    const result = await pool.query('SELECT two_factor_secret, two_factor_enabled FROM user_settings WHERE user_id = $1', [req.user.id]);
    const row = result.rows[0];
    if (!row?.two_factor_enabled) return res.status(400).json({ error: 'İki aşamalı doğrulama açık değil.' });

    const check = await twofactor.verifySecondFactor(req.user.id, row.two_factor_secret, req.body.code);
    if (!check.ok) {
      if (check.locked) return res.status(429).json({ error: `Çok fazla hatalı deneme. ${check.retryAfterMin} dakika sonra tekrar deneyin.` });
      return res.status(401).json({ error: 'Kod hatalı.' });
    }
    const backupCodes = await twofactor.replaceBackupCodes(req.user.id);
    res.json({ backupCodes });
  } catch (err) {
    console.error('2fa regenerate error', err);
    res.status(500).json({ error: 'Yedek kodlar yenilenemedi.' });
  }
});

module.exports = router;
