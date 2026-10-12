// Google ile giriş: istemciden gelen ID token'ı doğrular. GOOGLE_CLIENT_IDS (virgülle ayrılmış
// "Web" OAuth istemci kimlikleri) ayarlı değilse özellik tamamen kapalıdır.
const { OAuth2Client } = require('google-auth-library');

const clientIds = () => (process.env.GOOGLE_CLIENT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const enabled = () => clientIds().length > 0;

let client;

/** Dönüş: { sub, email, email_verified, name, picture }. Geçersizse fırlatır. */
async function verifyIdToken(idToken) {
  // Yalnızca testler için: gerçek Google'a gitmeden sahte token ("test:{json}"). Üretimde asla çalışmaz.
  if (process.env.NODE_ENV === 'test' && String(idToken).startsWith('test:')) {
    return JSON.parse(String(idToken).slice(5));
  }
  client = client || new OAuth2Client();
  const ticket = await client.verifyIdToken({ idToken, audience: clientIds() });
  const p = ticket.getPayload();
  return { sub: p.sub, email: p.email, email_verified: p.email_verified, name: p.name, picture: p.picture };
}

module.exports = { enabled, clientIds, verifyIdToken };
