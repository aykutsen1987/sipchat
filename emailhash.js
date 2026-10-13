// E-posta eşleştirme için anahtarlı özet. Düz e-posta eşleştirme tablolarında saklanmaz; özet,
// yalnızca sunucuda bulunan bir "biber" (pepper) ile HMAC'lenir. Veritabanı sızsa bile bir
// e-posta listesiyle özetler karşılaştırılamaz (biber olmadan hesaplanamaz).
const crypto = require('crypto');

const normalize = (email) => String(email || '').trim().toLowerCase();
const isEmail = (s) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(s) && s.length <= 254;

function hashEmail(email) {
  const pepper = process.env.EMAIL_PEPPER || process.env.JWT_SECRET;
  return crypto.createHmac('sha256', pepper).update(`email:${normalize(email)}`).digest('hex');
}

module.exports = { hashEmail, normalize, isEmail };
