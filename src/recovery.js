// Parola sıfırlama için "kurtarma anahtarı". Ücretsizdir: e-posta/SMS altyapısı gerektirmez.
//  - Anahtar 20 karakterdir (5 grup × 4; 32 harflik alfabe → 100 bit) ve yalnızca üretildiğinde bir kez gösterilir.
//  - Sunucu yalnızca anahtarlı özetini (HMAC-SHA256) saklar; veritabanı sızsa bile anahtar geri elde edilemez.
//  - Bir sıfırlama başarılı olunca anahtar yenilenir (tek kullanımlıktır) ve yeni anahtar döndürülür.
//  - Hatalı denemeler hesap bazında sayılır ve kilitlenir (2FA kilidiyle aynı mantık, ayrı sayaç).
const crypto = require('crypto');
const { pool } = require('./db');

// Karışabilecek 0/O/1/I yok.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_LENGTH = 20;

function generateKey() {
  const bytes = crypto.randomBytes(KEY_LENGTH);
  let raw = '';
  for (let i = 0; i < KEY_LENGTH; i += 1) raw += ALPHABET[bytes[i] % ALPHABET.length]; // 256 % 32 == 0 → önyargısız
  return raw.match(/.{4}/g).join('-');
}

function normalize(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function looksLikeKey(input) {
  const n = normalize(input);
  return n.length === KEY_LENGTH && [...n].every((c) => ALPHABET.includes(c));
}

function hashKey(input) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`recovery:${normalize(input)}`).digest('hex');
}

/** Yeni anahtar üretir, özetini yazar, düz anahtarı döndürür (eskisi geçersiz olur). */
async function issueKey(userId, db = pool) {
  const key = generateKey();
  await db.query('UPDATE users SET recovery_hash = $2, recovery_created_at = now() WHERE id = $1', [userId, hashKey(key)]);
  return key;
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

function keyMatches(storedHash, input) {
  if (!storedHash || !looksLikeKey(input)) return false;
  return safeEqualHex(storedHash, hashKey(input));
}

// --- Kaba kuvvet kilidi ---
const MAX_FAILS = 5;
const LOCK_MINUTES = 30;
const FAIL_WINDOW_MINUTES = 30;

async function lockRemainingMs(userId) {
  const r = await pool.query(
    `SELECT GREATEST(0, EXTRACT(EPOCH FROM (locked_until - now())) * 1000)::bigint AS ms
       FROM password_reset_attempts WHERE user_id = $1 AND locked_until IS NOT NULL`,
    [userId],
  );
  return r.rows.length ? Number(r.rows[0].ms) : 0;
}

async function recordFailure(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO password_reset_attempts (user_id, fail_count) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING',
      [userId],
    );
    const cur = await client.query(
      `SELECT fail_count,
              (locked_until IS NOT NULL AND locked_until <= now()) AS lock_expired,
              (updated_at < now() - ($2 || ' minutes')::interval) AS stale
         FROM password_reset_attempts WHERE user_id = $1 FOR UPDATE`,
      [userId, String(FAIL_WINDOW_MINUTES)],
    );
    const row = cur.rows[0];
    const base = row.lock_expired || row.stale ? 0 : row.fail_count;
    const count = base + 1;
    const lock = count >= MAX_FAILS;
    await client.query(
      `UPDATE password_reset_attempts
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
  await pool.query('DELETE FROM password_reset_attempts WHERE user_id = $1', [userId]);
}

module.exports = {
  generateKey, looksLikeKey, hashKey, issueKey, keyMatches, lockRemainingMs, recordFailure, clearFailures, LOCK_MINUTES,
};
