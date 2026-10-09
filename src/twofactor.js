// Ortak 2FA yardımcıları: ikinci faktör doğrulama (TOTP veya yedek kod),
// yedek kod saklama/tüketme ve kaba kuvvet kilidi.
const { pool } = require('./db');
const totp = require('./totp');

// --- Kaba kuvvet koruması (süreç içi; tek instance'lık Render için yeterli) ---
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map(); // userId -> { count, lockedUntil }

function lockRemainingMs(userId) {
  const f = failures.get(userId);
  if (!f || !f.lockedUntil) return 0;
  const left = f.lockedUntil - Date.now();
  if (left <= 0) { failures.delete(userId); return 0; }
  return left;
}

function recordFailure(userId) {
  const f = failures.get(userId) || { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) f.lockedUntil = Date.now() + LOCK_MS;
  failures.set(userId, f);
}

function clearFailures(userId) { failures.delete(userId); }

// --- Yedek kodlar ---
/** Eski kodları siler, yeni kodların özetlerini yazar. Düz kodları döndürür. */
async function replaceBackupCodes(userId) {
  const codes = totp.generateBackupCodes();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM two_factor_backup_codes WHERE user_id = $1', [userId]);
    await client.query(
      'INSERT INTO two_factor_backup_codes (user_id, code_hash) SELECT $1, unnest($2::text[])',
      [userId, codes.map(totp.hashBackupCode)],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return codes;
}

/** Kod geçerli ve kullanılmamışsa atomik olarak "kullanıldı" işaretler. */
async function consumeBackupCode(userId, code) {
  const r = await pool.query(
    `UPDATE two_factor_backup_codes SET used_at = now()
      WHERE id = (SELECT id FROM two_factor_backup_codes
                   WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL LIMIT 1)
      RETURNING id`,
    [userId, totp.hashBackupCode(code)],
  );
  return r.rowCount > 0;
}

async function countRemainingBackupCodes(userId) {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS n FROM two_factor_backup_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
  return r.rows[0].n;
}

/**
 * İkinci faktörü doğrular. Dönüş:
 *   { ok: true, via: 'totp' | 'backup' }  veya
 *   { ok: false, locked: boolean, retryAfterMin?: number }
 */
async function verifySecondFactor(userId, secret, rawCode) {
  const left = lockRemainingMs(userId);
  if (left > 0) return { ok: false, locked: true, retryAfterMin: Math.ceil(left / 60000) };

  const code = String(rawCode || '').trim();
  let via = null;
  if (/^\d{6}$/.test(code)) {
    if (secret && totp.verifyTotp(secret, code)) via = 'totp';
  } else if (totp.looksLikeBackupCode(code)) {
    if (await consumeBackupCode(userId, code)) via = 'backup';
  }

  if (!via) {
    recordFailure(userId);
    return { ok: false, locked: lockRemainingMs(userId) > 0, retryAfterMin: Math.ceil(lockRemainingMs(userId) / 60000) };
  }
  clearFailures(userId);
  return { ok: true, via };
}

module.exports = {
  replaceBackupCodes, consumeBackupCode, countRemainingBackupCodes, verifySecondFactor, lockRemainingMs,
};
