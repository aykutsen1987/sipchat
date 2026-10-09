#!/usr/bin/env node
// Komut satırı yönetim aracı (HTTP gerektirmez; DATABASE_URL yeterli).
//
//   npm run admin -- stats
//   npm run admin -- list [--days 365]            pasif kullanıcıları listele
//   npm run admin -- delete <kullanıcı_adı|id> --yes
//   npm run admin -- purge --days 365             DRY-RUN: kimler silinecek
//   npm run admin -- purge --days 365 --yes       gerçekten sil
require('dotenv').config();
const admin = require('../src/admin');
const { pool } = require('../src/db');

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
const table = (rows) => rows.forEach((u) => console.log(
  `${u.handle.padEnd(22)} son etkinlik ${fmt(u.last_active_at)} | kayıt ${fmt(u.created_at)} | ${String(u.message_count).padStart(5)} mesaj | ${u.chat_count} sohbet | ${u.id}`,
));

(async () => {
  try {
    if (cmd === 'stats') {
      console.log(await admin.stats());
    } else if (cmd === 'list') {
      const days = flag('days');
      const users = await admin.listUsers({ inactiveDays: days ? Number.parseInt(days, 10) : null, limit: 1000 });
      table(users);
      console.log(`\n${users.length} kullanıcı`);
    } else if (cmd === 'delete') {
      const target = args[1];
      if (!target || target.startsWith('--')) throw new Error('Kullanım: delete <kullanıcı_adı|id> --yes');
      const user = await admin.findUserByHandleOrId(target);
      if (!user) throw new Error('Kullanıcı bulunamadı.');
      if (!flag('yes')) { console.log(`"${user.handle}" silinecekti. Onaylamak için --yes ekleyin.`); return; }
      console.log(await admin.deleteUsers([user.id]));
    } else if (cmd === 'purge') {
      const days = Number.parseInt(flag('days'), 10);
      if (!Number.isFinite(days) || days < 30) throw new Error('--days en az 30 olmalı.');
      const users = await admin.listUsers({ inactiveDays: days, limit: 1000 });
      table(users);
      if (!flag('yes')) { console.log(`\nDRY-RUN: ${users.length} kullanıcı silinecekti. Gerçekten silmek için --yes ekleyin.`); return; }
      console.log('\n', await admin.deleteUsers(users.map((u) => u.id)));
    } else {
      console.log('Komutlar: stats | list [--days N] | delete <ad|id> --yes | purge --days N [--yes]');
    }
  } catch (err) {
    console.error('Hata:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
