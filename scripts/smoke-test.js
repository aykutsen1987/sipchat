// Uçtan uca duman testi (gerçek PostgreSQL gerekir): yeni özellikleri REST üzerinden dener.
//   DATABASE_URL=postgres://... JWT_SECRET=... ADMIN_API_KEY=<24+ karakter> node scripts/smoke-test.js
// Sunucuyu kendisi başlatır (PORT=3456) ve işi bitince kapatır. Kayıt olan test kullanıcıları rastgele ek taşır.
const { spawn } = require('child_process');

const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = process.env.ADMIN_API_KEY || 'admin-key-for-smoke-test-0123456789';
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); } else { failed += 1; console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function call(method, path, { token, body, admin, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-key'] = ADMIN_KEY;
  let payload;
  if (raw) { payload = raw.body; headers['content-type'] = raw.type; } else if (body) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  let json = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) json = await res.json().catch(() => null);
  return { status: res.status, json, res };
}

const rand = Math.random().toString(36).slice(2, 8);
async function register(name) {
  const r = await call('POST', '/api/auth/register', { body: { handle: `${name}_${rand}`, displayName: name, password: 'password123' } });
  return { ...r.json, handle: `${name}_${rand}`, status: r.status };
}

function multipartFile(field, filename, mime, bytes) {
  const boundary = `----smoke${Date.now()}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { type: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat([head, bytes, tail]) };
}

async function run() {
  console.log('Kayıt + kurtarma anahtarı');
  const a = await register('alice');
  const b = await register('bob');
  const c = await register('carol');
  check('register 201 + recoveryKey', a.status === 201 && /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/.test(a.recoveryKey || ''), a.recoveryKey);
  const st = await call('GET', '/api/auth/recovery-key/status', { token: a.token });
  check('recovery status exists', st.json?.exists === true);

  console.log('Sohbet, yanıt, iletme, düzenleme');
  const direct = await call('POST', '/api/chats', { token: a.token, body: { type: 'DIRECT', userId: b.user.id } });
  const chatId = direct.json.chatId;
  const m1 = await call('POST', `/api/chats/${chatId}/messages`, { token: a.token, body: { text: 'merhaba' } });
  check('send message', m1.status === 201 && m1.json.message.reply_to_id === null && m1.json.message.forwarded === false);
  const m2 = await call('POST', `/api/chats/${chatId}/messages`, { token: b.token, body: { text: 'selam', replyToId: m1.json.message.id } });
  check('reply_to_id stored', m2.status === 201 && m2.json.message.reply_to_id === m1.json.message.id, m2.json);
  const badReply = await call('POST', `/api/chats/${chatId}/messages`, { token: b.token, body: { text: 'x', replyToId: '00000000-0000-4000-8000-000000000000' } });
  check('reply to unknown message rejected', badReply.status === 400);
  const fwd = await call('POST', `/api/chats/${chatId}/messages`, { token: a.token, body: { text: 'iletildi', forwarded: true } });
  check('forwarded flag', fwd.json.message.forwarded === true);

  const edit = await call('PATCH', `/api/chats/${chatId}/messages/${m1.json.message.id}`, { token: a.token, body: { text: 'merhaba (düzenlendi)' } });
  check('edit own message', edit.status === 200 && edit.json.message.text === 'merhaba (düzenlendi)' && !!edit.json.message.edited_at, edit.json);
  const editOther = await call('PATCH', `/api/chats/${chatId}/messages/${m1.json.message.id}`, { token: b.token, body: { text: 'hack' } });
  check("cannot edit someone else's message", editOther.status === 404);
  const oldEdit = await call('PATCH', `/api/chats/${chatId}/messages/${m2.json.message.id}`, { token: b.token, body: { text: 'ok' } });
  check('edit within window ok', oldEdit.status === 200);

  // medya + iletme
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
  const up = await call('POST', `/api/chats/${chatId}/media`, { token: a.token, raw: multipartFile('file', 'x.png', 'image/png', png) });
  check('upload media', up.status === 201 && up.json.message.type === 'IMAGE', up.json);
  const direct2 = await call('POST', '/api/chats', { token: a.token, body: { type: 'DIRECT', userId: c.user.id } });
  const fm = await call('POST', `/api/chats/${direct2.json.chatId}/forward`, { token: a.token, body: { sourceChatId: chatId, messageId: up.json.message.id } });
  check('forward media copies bytes', fm.status === 201 && fm.json.message.forwarded === true && fm.json.message.has_media === true, fm.json);
  const media = await call('GET', `/api/media/${fm.json.message.id}`, { token: c.token });
  check('forwarded media readable by new chat member', media.status === 200);
  const fmBad = await call('POST', `/api/chats/${direct2.json.chatId}/forward`, { token: c.token, body: { sourceChatId: chatId, messageId: up.json.message.id } });
  check('cannot forward from chat you are not in', fmBad.status === 403);

  console.log('Sayfalama');
  for (let i = 0; i < 12; i += 1) await call('POST', `/api/chats/${chatId}/messages`, { token: a.token, body: { text: `m${i}` } });
  const p1 = await call('GET', `/api/chats/${chatId}/messages?limit=5`, { token: a.token });
  check('page 1 has 5 + hasMore', p1.json.messages.length === 5 && p1.json.hasMore === true);
  const oldest = p1.json.messages[0].created_at;
  const p2 = await call('GET', `/api/chats/${chatId}/messages?limit=5&before=${encodeURIComponent(oldest)}`, { token: a.token });
  const ids1 = new Set(p1.json.messages.map((m) => m.id));
  const overlap = p2.json.messages.filter((m) => ids1.has(m.id)).length;
  check('page 2 older than page 1', p2.json.messages.length >= 5 && p2.json.messages[p2.json.messages.length - 1].created_at <= oldest, p2.json.messages.map((m) => m.created_at));
  check('page 2 overlap at most 1 (ms boundary)', overlap <= 1, overlap);
  let before = oldest; let total = p1.json.messages.length; let guard = 0; const seen = new Set(ids1);
  let more = true;
  while (more && guard < 20) {
    guard += 1;
    // eslint-disable-next-line no-await-in-loop
    const pg = await call('GET', `/api/chats/${chatId}/messages?limit=5&before=${encodeURIComponent(before)}`, { token: a.token });
    pg.json.messages.forEach((m) => { if (!seen.has(m.id)) { seen.add(m.id); total += 1; } });
    more = pg.json.hasMore; before = pg.json.messages[0]?.created_at || before;
  }
  const all = await call('GET', `/api/chats/${chatId}/messages?limit=200`, { token: a.token });
  check('paging walks the whole history', seen.size === all.json.messages.length, { seen: seen.size, all: all.json.messages.length });
  const badBefore = await call('GET', `/api/chats/${chatId}/messages?before=abc`, { token: a.token });
  check('bad before rejected', badBefore.status === 400);

  console.log('Grup yönetimi');
  const grp = await call('POST', '/api/chats', { token: a.token, body: { type: 'GROUP', title: 'Ekip', memberIds: [b.user.id, c.user.id] } });
  const gid = grp.json.chatId;
  const mem = await call('GET', `/api/chats/${gid}/members`, { token: a.token });
  check('creator is admin, others members', mem.json.members.find((u) => u.id === a.user.id)?.isAdmin === true && mem.json.members.filter((u) => u.isAdmin).length === 1, mem.json);
  const d = await register('dave');
  const addByMember = await call('POST', `/api/chats/${gid}/members`, { token: b.token, body: { memberIds: [d.user.id] } });
  check('member cannot add', addByMember.status === 403);
  const addByAdmin = await call('POST', `/api/chats/${gid}/members`, { token: a.token, body: { memberIds: [d.user.id] } });
  check('admin can add', addByAdmin.status === 204);
  const rmByMember = await call('DELETE', `/api/chats/${gid}/members/${d.user.id}`, { token: b.token });
  check('member cannot remove', rmByMember.status === 403);
  const rm = await call('DELETE', `/api/chats/${gid}/members/${d.user.id}`, { token: a.token });
  check('admin removes member', rm.status === 204);
  const dChats = await call('GET', '/api/chats', { token: d.token });
  check('removed user no longer lists group', !dChats.json.chats.some((x) => x.id === gid));
  const dSend = await call('POST', `/api/chats/${gid}/messages`, { token: d.token, body: { text: 'hala buradayım' } });
  check('removed user cannot post', dSend.status === 403);
  const promote = await call('PUT', `/api/chats/${gid}/members/${b.user.id}/role`, { token: a.token, body: { role: 'ADMIN' } });
  check('promote to admin', promote.status === 200);
  const rmAdmin = await call('DELETE', `/api/chats/${gid}/members/${b.user.id}`, { token: a.token });
  check('cannot remove admin directly', rmAdmin.status === 409);
  const demote = await call('PUT', `/api/chats/${gid}/members/${b.user.id}/role`, { token: a.token, body: { role: 'MEMBER' } });
  check('demote ok while another admin exists', demote.status === 200);
  const demoteLast = await call('PUT', `/api/chats/${gid}/members/${a.user.id}/role`, { token: a.token, body: { role: 'MEMBER' } });
  check('cannot demote the last admin', demoteLast.status === 409);
  const rename = await call('PATCH', `/api/chats/${gid}`, { token: a.token, body: { title: 'Yeni Ad' } });
  check('rename by admin', rename.status === 200);
  const renameMember = await call('PATCH', `/api/chats/${gid}`, { token: c.token, body: { title: 'Hack' } });
  check('rename by member refused', renameMember.status === 403);
  const photoUp = await call('PUT', `/api/chats/${gid}/photo`, { token: a.token, raw: multipartFile('file', 'g.png', 'image/png', png) });
  check('group photo upload', photoUp.status === 200 && /\/api\/chats\/.+\/photo/.test(photoUp.json?.photoUrl || ''), photoUp.json);
  const photoMember = await call('PUT', `/api/chats/${gid}/photo`, { token: c.token, raw: multipartFile('file', 'g.png', 'image/png', png) });
  check('group photo by member refused', photoMember.status === 403);
  const photoGet = await call('GET', `/api/chats/${gid}/photo`, { token: c.token });
  check('member can view group photo', photoGet.status === 200 && photoGet.res.headers.get('content-type') === 'image/png');
  const photoOut = await call('GET', `/api/chats/${gid}/photo`, { token: d.token });
  check('non-member cannot view group photo', photoOut.status === 403);
  const photoBad = await call('PUT', `/api/chats/${gid}/photo`, { token: a.token, raw: multipartFile('file', 'g.png', 'image/png', Buffer.from('not an image at all')) });
  check('non-image rejected', photoBad.status === 400);
  const list = await call('GET', '/api/chats', { token: c.token });
  const gRow = list.json.chats.find((x) => x.id === gid);
  check('chat list carries title + photo_url + my_role', gRow.title === 'Yeni Ad' && !!gRow.photo_url && gRow.my_role === 'MEMBER', gRow);
  // yönetici ayrılırsa devir
  const leave = await call('DELETE', `/api/chats/${gid}/members/me`, { token: a.token });
  check('admin leaves', leave.status === 204);
  const mem2 = await call('GET', `/api/chats/${gid}/members`, { token: b.token });
  check('a new admin is promoted automatically', mem2.json.members.filter((u) => u.isAdmin).length === 1, mem2.json);

  console.log('Şikayet');
  const rep = await call('POST', '/api/reports', { token: b.token, body: { targetUserId: a.user.id, reason: 'SPAM', chatId, messageId: m1.json.message.id, alsoBlock: true } });
  check('report created', rep.status === 201 && !!rep.json.id, rep.json);
  const repDup = await call('POST', '/api/reports', { token: b.token, body: { targetUserId: a.user.id, reason: 'SPAM', chatId, messageId: m1.json.message.id } });
  check('duplicate report returns same id', repDup.json.id === rep.json.id);
  const repMedia = await call('POST', '/api/reports', { token: b.token, body: { targetUserId: a.user.id, reason: 'SEXUAL', messageId: up.json.message.id } });
  check('report with media evidence', repMedia.status === 201);
  const repSelf = await call('POST', '/api/reports', { token: a.token, body: { targetUserId: a.user.id, reason: 'SPAM' } });
  check('cannot report self', repSelf.status === 400);
  const repStranger = await call('POST', '/api/reports', { token: d.token, body: { targetUserId: a.user.id, reason: 'SPAM' } });
  check('cannot report someone you share no chat with', repStranger.status === 403);
  const repBad = await call('POST', '/api/reports', { token: b.token, body: { targetUserId: a.user.id, reason: 'NOPE' } });
  check('invalid reason rejected', repBad.status === 400);
  const blocked = await call('GET', '/api/users/blocked', { token: b.token });
  check('alsoBlock blocks the target', blocked.json.users.some((u) => u.id === a.user.id));
  const noKey = await call('GET', '/api/admin/reports', {});
  check('admin reports need key', noKey.status === 401);
  const lst = await call('GET', '/api/admin/reports?status=OPEN', { admin: true });
  const row = lst.json.reports.find((r) => r.id === rep.json.id);
  check('admin lists report with snapshot', !!row && row.snapshot.text === 'merhaba (düzenlendi)' && row.reporter_handle === b.handle, row);
  const ev = lst.json.reports.find((r) => r.id === repMedia.json.id);
  check('media evidence flagged', ev?.has_evidence_media === true);
  const evBytes = await call('GET', `/api/admin/reports/${repMedia.json.id}/media`, { admin: true });
  check('admin fetches evidence media', evBytes.status === 200 && evBytes.res.headers.get('content-type') === 'image/png');
  const resolveRm = await call('POST', `/api/admin/reports/${rep.json.id}/resolve`, { admin: true, body: { action: 'REMOVE_MESSAGE' } });
  check('resolve REMOVE_MESSAGE', resolveRm.status === 200 && resolveRm.json.removedMessage?.id === m1.json.message.id, resolveRm.json);
  const gone = await call('GET', `/api/chats/${chatId}/messages?limit=200`, { token: a.token });
  check('message really removed', !gone.json.messages.some((m) => m.id === m1.json.message.id));
  const resolveDis = await call('POST', `/api/admin/reports/${repMedia.json.id}/resolve`, { admin: true, body: { action: 'DISMISS' } });
  check('resolve DISMISS', resolveDis.status === 200);
  const evGone = await call('GET', `/api/admin/reports/${repMedia.json.id}/media`, { admin: true });
  check('evidence freed after resolve', evGone.status === 404);
  const stats = await call('GET', '/api/admin/stats', { admin: true });
  check('stats include open_reports', typeof stats.json.open_reports === 'number');

  console.log('Parola sıfırlama');
  const wrong = await call('POST', '/api/auth/reset-password', { body: { handle: a.handle, recoveryKey: 'AAAA-AAAA-AAAA-AAAA-AAAA', newPassword: 'newpassword1' } });
  check('wrong key rejected', wrong.status === 401);
  const unknown = await call('POST', '/api/auth/reset-password', { body: { handle: 'nobody_zz', recoveryKey: 'AAAA-AAAA-AAAA-AAAA-AAAA', newPassword: 'newpassword1' } });
  check('unknown user gives same generic error', unknown.status === 401 && unknown.json.error === wrong.json.error);
  const short = await call('POST', '/api/auth/reset-password', { body: { handle: a.handle, recoveryKey: a.recoveryKey, newPassword: 'short' } });
  check('short new password rejected', short.status === 400);
  const ok = await call('POST', '/api/auth/reset-password', { body: { handle: a.handle, recoveryKey: a.recoveryKey.toLowerCase().replace(/-/g, ' '), newPassword: 'newpassword1' } });
  check('reset with correct key (format tolerant)', ok.status === 200 && ok.json.recoveryKey && ok.json.recoveryKey !== a.recoveryKey, ok.json);
  const oldSession = await call('GET', '/api/auth/me', { token: a.token });
  check('old session revoked', oldSession.status === 401);
  const loginOld = await call('POST', '/api/auth/login', { body: { handle: a.handle, password: 'password123' } });
  check('old password no longer works', loginOld.status === 401);
  const loginNew = await call('POST', '/api/auth/login', { body: { handle: a.handle, password: 'newpassword1' } });
  check('new password works', loginNew.status === 200 && !!loginNew.json.token);
  const reuse = await call('POST', '/api/auth/reset-password', { body: { handle: a.handle, recoveryKey: a.recoveryKey, newPassword: 'another12345' } });
  check('old key is single-use', reuse.status === 401);
  // kilit
  let locked = false;
  for (let i = 0; i < 7; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await call('POST', '/api/auth/reset-password', { body: { handle: b.handle, recoveryKey: 'BBBB-BBBB-BBBB-BBBB-BBBB', newPassword: 'whatever123' } });
    if (r.status === 429) { locked = true; break; }
  }
  check('brute force locks the account', locked);
  const lockedGood = await call('POST', '/api/auth/reset-password', { body: { handle: b.handle, recoveryKey: b.recoveryKey, newPassword: 'whatever123' } });
  check('even the right key is refused while locked', lockedGood.status === 429);
  // anahtar yenileme (parola ister)
  const reg1 = await call('POST', '/api/auth/recovery-key', { token: loginNew.json.token, body: {} });
  check('regenerate needs password', reg1.status === 400);
  const reg2 = await call('POST', '/api/auth/recovery-key', { token: loginNew.json.token, body: { password: 'wrong' } });
  check('regenerate refuses wrong password', reg2.status === 403);
  const reg3 = await call('POST', '/api/auth/recovery-key', { token: loginNew.json.token, body: { password: 'newpassword1' } });
  check('regenerate with password', reg3.status === 200 && !!reg3.json.recoveryKey);
  // 2FA açıkken kod da gerekir
  const setup = await call('POST', '/api/auth/2fa/setup', { token: loginNew.json.token });
  const totp = require('../src/totp');
  await call('POST', '/api/auth/2fa/enable', { token: loginNew.json.token, body: { code: totp.generateTotp(setup.json.secret) } });
  const need2fa = await call('POST', '/api/auth/reset-password', { body: { handle: a.handle, recoveryKey: reg3.json.recoveryKey, newPassword: 'third-password1' } });
  check('2FA account: reset asks for a code', need2fa.status === 401 && need2fa.json.requiresTwoFactor === true, need2fa.json);
  const with2fa = await call('POST', '/api/auth/reset-password', { body: { handle: a.handle, recoveryKey: reg3.json.recoveryKey, newPassword: 'third-password1', code: totp.generateTotp(setup.json.secret) } });
  check('2FA account: reset works with the code', with2fa.status === 200, with2fa.json);

  console.log('Google ile parola sıfırlama');
  const gTok = `test:${JSON.stringify({ sub: `sub-${rand}`, email: `c_${rand}@example.com`, email_verified: true })}`;
  const gUnlinked = await call('POST', '/api/auth/reset-password/google', { body: { idToken: gTok, newPassword: 'whatever123' } });
  check('google reset for unlinked Google account -> 404', gUnlinked.status === 404, gUnlinked.json);
  const link = await call('POST', '/api/auth/google/link', { token: c.token, body: { idToken: gTok } });
  check('link google', link.status === 200, link.json);
  const gReset = await call('POST', '/api/auth/reset-password/google', { body: { idToken: gTok, newPassword: 'googlepass123' } });
  check('google reset works for linked account', gReset.status === 200 && gReset.json.handle === c.handle, gReset.json);
  const cOld = await call('GET', '/api/auth/me', { token: c.token });
  check('google reset revokes sessions', cOld.status === 401);
  const cLogin = await call('POST', '/api/auth/login', { body: { handle: c.handle, password: 'googlepass123' } });
  check('login with the new password after google reset', cLogin.status === 200);

  console.log('Sohbet silme / hesap silinince');
  const e = await register('erin');
  const f = await register('frank');
  const ef = await call('POST', '/api/chats', { token: e.token, body: { type: 'DIRECT', userId: f.user.id } });
  const delGroupLike = await call('DELETE', `/api/chats/${gid}`, { token: b.token });
  check('DELETE /chats/:id refuses groups', delGroupLike.status === 400);
  const delOutsider = await call('DELETE', `/api/chats/${ef.json.chatId}`, { token: d.token });
  check('outsider cannot delete', delOutsider.status === 403);
  const delMine = await call('DELETE', `/api/chats/${ef.json.chatId}`, { token: e.token });
  check('delete direct chat for me', delMine.status === 204);
  const eList = await call('GET', '/api/chats', { token: e.token });
  check('chat gone from my list', !eList.json.chats.some((x) => x.id === ef.json.chatId));
  const fList = await call('GET', '/api/chats', { token: f.token });
  check("peer's copy stays", fList.json.chats.some((x) => x.id === ef.json.chatId));
  const delOnly = await call('DELETE', `/api/chats/${ef.json.chatId}`, { token: f.token });
  check('last member deleting removes the chat for good', delOnly.status === 204);
  // hesap silinince karşı taraftaki sohbet de kalkmalı
  const gh = await register('gina');
  const hh = await register('hank');
  const gc = await call('POST', '/api/chats', { token: gh.token, body: { type: 'DIRECT', userId: hh.user.id } });
  const delAcct = await call('DELETE', '/api/auth/me', { token: gh.token, body: { password: 'password123' } });
  check('account deleted', delAcct.status === 204 || delAcct.status === 200, delAcct.status);
  const hList = await call('GET', '/api/chats', { token: hh.token });
  check("peer's chat with the deleted account is gone from the server", !hList.json.chats.some((x) => x.id === gc.json.chatId));

  console.log('Yedek sınırı');
  const big = Buffer.alloc(11 * 1024 * 1024, 7);
  const bk = await call('PUT', '/api/backup', { token: loginNew.json.token, raw: { type: 'application/octet-stream', body: big } });
  check('11 MB backup accepted now', bk.status === 200 || bk.status === 401, bk.status);
}

(async () => {
  const server = spawn('node', ['src/index.js'], {
    env: { ...process.env, PORT: String(PORT), ADMIN_API_KEY: ADMIN_KEY, NODE_ENV: 'test', AUTH_RATE_LIMIT_MAX: '1000', GOOGLE_CLIENT_IDS: 'test-client-id' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  server.stdout.on('data', (d) => { if (String(d).includes('listening')) ready = true; });
  server.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !ready; i += 1) await new Promise((r) => setTimeout(r, 200)); // eslint-disable-line no-await-in-loop
  try {
    await run();
  } catch (err) {
    failed += 1; console.error('TEST CRASH', err);
  } finally {
    server.kill();
  }
  console.log(`\n${passed} geçti, ${failed} başarısız`);
  process.exit(failed ? 1 : 0);
})();
