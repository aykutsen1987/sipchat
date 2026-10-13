const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const admin = require('../admin');

const router = express.Router();

// Yönetici uç noktaları ADMIN_API_KEY ayarlı değilse hiç var olmaz (404).
// Anahtar, normal kullanıcı JWT'sinden tamamen ayrıdır ve yalnızca sizde olmalıdır.
const MIN_KEY_LENGTH = 24;

function keyMatches(provided) {
  const expected = process.env.ADMIN_API_KEY || '';
  const a = crypto.createHash('sha256').update(String(provided || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  const key = process.env.ADMIN_API_KEY || '';
  if (key.length < MIN_KEY_LENGTH) return res.status(404).json({ error: 'Bulunamadı.' });
  return next();
});
router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));
router.use((req, res, next) => {
  if (!keyMatches(req.headers['x-admin-key'])) return res.status(401).json({ error: 'Yönetici anahtarı geçersiz.' });
  return next();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toInt = (v, def, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    res.json(await admin.stats());
  } catch (err) {
    console.error('admin stats error', err);
    res.status(500).json({ error: 'İstatistik alınamadı.' });
  }
});

// GET /api/admin/users?inactiveDays=365&limit=200&offset=0
// inactiveDays yoksa tüm kullanıcılar, en uzun süredir pasif olan önce.
router.get('/users', async (req, res) => {
  try {
    const inactiveDays = req.query.inactiveDays == null ? null : toInt(req.query.inactiveDays, 365, 1, 36500);
    const users = await admin.listUsers({
      inactiveDays,
      limit: toInt(req.query.limit, 200, 1, 1000),
      offset: toInt(req.query.offset, 0, 0, 1_000_000),
    });
    res.json({ count: users.length, users });
  } catch (err) {
    console.error('admin list users error', err);
    res.status(500).json({ error: 'Liste alınamadı.' });
  }
});

// DELETE /api/admin/users/:idOrHandle — tek kullanıcıyı kalıcı siler.
router.delete('/users/:idOrHandle', async (req, res) => {
  try {
    const user = await admin.findUserByHandleOrId(req.params.idOrHandle);
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    const result = await admin.deleteUsers([user.id]);
    res.json({ handle: user.handle, ...result });
  } catch (err) {
    console.error('admin delete user error', err);
    res.status(500).json({ error: 'Kullanıcı silinemedi.' });
  }
});

// POST /api/admin/users/purge-inactive {days, dryRun?: true, confirm?: "DELETE"}
// Varsayılan DRY-RUN'dır: kimin silineceğini listeler, hiçbir şey silmez.
// Gerçekten silmek için dryRun:false VE confirm:"DELETE" birlikte gerekir.
router.post('/users/purge-inactive', async (req, res) => {
  const days = Number.parseInt(req.body?.days, 10);
  if (!Number.isFinite(days) || days < 30) {
    return res.status(400).json({ error: 'days en az 30 olmalı (yanlışlıkla toplu silmeye karşı).' });
  }
  const dryRun = req.body?.dryRun !== false;
  if (!dryRun && req.body?.confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Silmek için confirm: "DELETE" gönderin.' });
  }
  try {
    const users = await admin.listUsers({ inactiveDays: days, limit: 1000 });
    if (dryRun) {
      return res.json({ dryRun: true, days, wouldDelete: users.length, users });
    }
    const result = await admin.deleteUsers(users.map((u) => u.id));
    return res.json({ dryRun: false, days, ...result, handles: users.map((u) => u.handle) });
  } catch (err) {
    console.error('admin purge error', err);
    return res.status(500).json({ error: 'Temizlik başarısız.' });
  }
});

module.exports = router;
