const { verifyToken } = require('../utils/jwt');

/**
 * Protects REST routes: expects "Authorization: Bearer <token>".
 * Attaches { id, handle } to req.user on success.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Yetkilendirme gerekli (Bearer token eksik).' });
  }

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, handle: payload.handle };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token.' });
  }
}

module.exports = { requireAuth };
