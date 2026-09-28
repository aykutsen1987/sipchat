const { pool } = require('../db');

let admin = null;
let initialized = false;

/**
 * Lazily initializes firebase-admin from the FIREBASE_SERVICE_ACCOUNT_JSON
 * env var (the full service-account JSON, as one line/base64 — see
 * backend README, "Push Bildirimleri" section). If it's not set, push
 * sending silently no-ops everywhere else in this file — the rest of the
 * app (messaging, calls, etc.) keeps working normally without it.
 */
function tryInit() {
  if (initialized) return;
  initialized = true;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.log('FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled.');
    return;
  }

  try {
    // Accept either raw JSON or base64-encoded JSON (base64 is easier to
    // paste into a single-line Render env var without escaping quotes).
    const jsonText = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(jsonText);

    // eslint-disable-next-line global-require
    admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('firebase-admin initialized — push notifications enabled.');
  } catch (err) {
    console.error('Failed to initialize firebase-admin; push disabled.', err);
    admin = null;
  }
}

/**
 * Sends a push to every device token registered for userId, best-effort.
 * Never throws — a push failure must never break message delivery.
 */
async function sendPushToUser(userId, { title, body }) {
  tryInit();
  if (!admin) return;

  try {
    const result = await pool.query('SELECT token FROM push_tokens WHERE user_id = $1', [userId]);
    const tokens = result.rows.map((r) => r.token);
    if (tokens.length === 0) return;

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      android: { priority: 'high' },
    });

    // Clean up tokens Firebase reports as dead/unregistered.
    const deadTokens = [];
    response.responses.forEach((r, i) => {
      if (!r.success && ['messaging/registration-token-not-registered', 'messaging/invalid-argument'].includes(r.error?.code)) {
        deadTokens.push(tokens[i]);
      }
    });
    if (deadTokens.length > 0) {
      await pool.query('DELETE FROM push_tokens WHERE token = ANY($1)', [deadTokens]);
    }
  } catch (err) {
    console.error('sendPushToUser error (non-fatal)', err);
  }
}

module.exports = { sendPushToUser };
