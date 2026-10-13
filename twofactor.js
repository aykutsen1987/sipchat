// Ortak 2FA yardımcıları: ikinci faktör doğrulama (TOTP veya yedek kod),
// yedek kod saklama/tüketme ve kaba kuvvet kilidi.
const { pool } = require('./db');
const totp = require('./totp');

// --- Kaba kuvvet koruması (veritabanında; yeniden başlatmadan etkilenmez,
// birden fazla instance arasında paylaşılır) ---
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
// Bu süredir hiç deneme yapılmadıysa eski hatalar sayılmaz.
const FAIL_WINDOW_MINUTES = 15;

/** Kilidin bitmesine kalan milisaniye (kilitli değilse 0). */
async function lockRemainingMs(userId) {
  const r = await pool.query(
    `SELECT GREATEST(0, EXTRACT(EPOCH FROM (locked_until - now())) * 1000)::bigint AS ms
       FROM two_factor_attempts WHERE user_id = $1 AND locked_until IS NOT NULL`,
    [userId],
  );
  return r.rows.length ? Number(r.rows[0].ms) : 0;
}

/** Hatalı denemeyi atomik kaydeder; eşik aşılırsa hesabı kilitler. */
async function recordFailure(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO two_factor_attempts (user_id, fail_count) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING',
      [userId],
    );
    const cur = await client.query(
      `SELECT fail_count,
              (locked_until IS NOT NULL AND locked_until <= now()) AS lock_expired,
              (updated_at < now() - ($2 || ' minutes')::interval) AS stale
         FROM two_factor_attempts WHERE user_id = $1 FOR UPDATE`,
      [userId, String(FAIL_WINDOW_MINUTES)],
    );
    const row = cur.rows[0];
    const base = row.lock_expired || row.stale ? 0 : row.fail_count;
    const count = base + 1;
    const lock = count >= MAX_FAILS;
    await client.query(
      `UPDATE two_factor_attempts
          SET fail_count = $2,
              locked_until = CASE WHEN $3::boolean THEN now() + ($4 || ' minutes')::interval ELSE NULL END,
              updated_at = now()
        WHERE user_id = $1`,
      [userId, count, lock, String(LOCK_MINUTES)],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function clearFailures(userId) {
  await pool.query('DELETE FROM two_factor_attempts WHERE user_id = $1', [userId]);
}

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
  const left = await lockRemainingMs(userId);
  if (left > 0) return { ok: false, locked: true, retryAfterMin: Math.ceil(left / 60000) };

  const code = String(rawCode || '').trim();
  let via = null;
  if (/^\d{6}$/.test(code)) {
    if (secret && totp.verifyTotp(secret, code)) via = 'totp';
  } else if (totp.looksLikeBackupCode(code)) {
    if (await consumeBackupCode(userId, code)) via = 'backup';
  }

  if (!via) {
    await recordFailure(userId);
    const after = await lockRemainingMs(userId);
    return { ok: false, locked: after > 0, retryAfterMin: Math.ceil(after / 60000) };
  }
  await clearFailures(userId);
  return { ok: true, via };
}

module.exports = {
  replaceBackupCodes, consumeBackupCode, countRemainingBackupCodes, verifySecondFactor, lockRemainingMs,
};
