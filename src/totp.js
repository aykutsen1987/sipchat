// RFC 6238 (TOTP) / RFC 4226 (HOTP) — hand-written, zero dependencies, using
// only Node's built-in crypto module. Compatible with Google Authenticator,
// Authy, and any other standard authenticator app.
const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.substring(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder !== 0) {
    const lastChunk = bits.substring(bits.length - remainder).padEnd(5, '0');
    output += BASE32_ALPHABET[parseInt(lastChunk, 2)];
  }
  return output;
}

function base32Decode(input) {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) continue;
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** 160-bit secret — the standard size recommended for TOTP (RFC 4226 §4). */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

function generateTotp(base32Secret, atTimeMs = Date.now(), stepSeconds = 30) {
  const counter = Math.floor(atTimeMs / 1000 / stepSeconds);
  return hotp(base32Decode(base32Secret), counter);
}

/** Accepts the current 30s window and one step before/after (clock drift tolerance). */
function verifyTotp(base32Secret, code, window = 1, stepSeconds = 30) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const now = Date.now();
  for (let step = -window; step <= window; step++) {
    if (generateTotp(base32Secret, now + step * stepSeconds * 1000, stepSeconds) === code) return true;
  }
  return false;
}

function buildOtpAuthUri(accountLabel, secret, issuer = 'SipChat') {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// --- Yedek kodlar (2FA kurtarma) ------------------------------------------
// 10 karakterlik, karışması kolay karakterler (0/O, 1/I/L) çıkarılmış alfabe.
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BACKUP_CODE_COUNT = 10;

/** "ABCDE-FGHJK" biçiminde 10 karakterlik (~49 bit) rastgele kod. */
function generateBackupCode() {
  let raw = '';
  for (let i = 0; i < 10; i += 1) raw += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  return Array.from({ length: count }, generateBackupCode);
}

/** Kullanıcının yazdığı kodu normalize eder (büyük harf, tire/boşluk yok). */
function normalizeBackupCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function looksLikeBackupCode(input) {
  const n = normalizeBackupCode(input);
  return n.length === 10 && [...n].every((c) => BACKUP_ALPHABET.includes(c));
}

/** Deterministik (aranabilir) HMAC özeti; JWT_SECRET "pepper" olarak kullanılır. */
function hashBackupCode(input) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(normalizeBackupCode(input)).digest('hex');
}

module.exports = {
  generateSecret, generateTotp, verifyTotp, buildOtpAuthUri,
  generateBackupCodes, hashBackupCode, looksLikeBackupCode, BACKUP_CODE_COUNT,
};
