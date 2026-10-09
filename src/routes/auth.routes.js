const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { signToken, verifyToken } = require('../utils/jwt');
const { requireAuth } = require('../middleware/auth');
const totp = require('../totp');
const twofactor = require('../twofactor');

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

      const { token } = await createSession(user.id, user.handle, deviceName);
      return res.status(201).json({ token, user: toPublicUser(user) });
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
