const { verifyToken } = require('../utils/jwt');
const { pool } = require('../db');

/**
 * Protects REST routes: expects "Authorization: Bearer <token>".
 * Attaches { id, handle } to req.user, and the session id (if present in
 * the token) to req.sessionId, on success.
 *
 * Tokens carry a "sid" claim identifying their row in the `sessions` table
 * (see "Bağlı Cihazlar" / routes/sessions.routes.js). If that session has
 * been revoked (remote "sign out this device"), the token is rejected even
 * though it's still cryptographically valid and unexpired — this is what
 * makes "Bağlı Cihazlar" → revoke actually work.
 *
 * Tokens issued before this feature existed have no "sid" claim; those are
 * accepted as before (fail-open) so upgrading never logs existing sessions
 * out. A DB hiccup while checking revocation also fails open — this check
 * must never be the reason the whole API goes down.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Yetkilendirme gerekli (Bearer token eksik).' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token.' });
  }

  req.user = { id: payload.sub, handle: payload.handle };
  req.sessionId = payload.sid || null;

  if (payload.sid) {
    try {
      const result = await pool.query('SELECT revoked_at FROM sessions WHERE id = $1', [payload.sid]);
      if (result.rows.length === 0) {
        // Oturum satırı yok: hesap silinmiş (ör. pasif hesap temizliği) ya da oturum
        // tamamen kaldırılmış. İmzası geçerli olsa bile token artık kabul edilmez.
        return res.status(401).json({ error: 'Oturum bulunamadı; lütfen tekrar giriş yapın.' });
      }
      if (result.rows[0].revoked_at) {
        return res.status(401).json({ error: 'Bu oturum başka bir cihazdan sonlandırıldı.' });
      }
      // "Son etkinlik" ölçümü için (pasif hesap temizliği): en fazla saatte bir yazılır.
      pool.query(
        "UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 hour'",
        [payload.sid],
      ).catch(() => {});
    } catch (err) {
      console.error('session check error (failing open)', err);
    }
  }

  return next();
}

module.exports = { requireAuth };
