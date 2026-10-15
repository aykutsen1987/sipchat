// Yönetim işlemleri: pasif kullanıcıları listeleme ve silme.
// Hem HTTP (routes/admin.routes.js) hem komut satırı (scripts/admin.js) bunu kullanır.
const { pool } = require('./db');

/**
 * "Son etkinlik" = şunların en yenisi: hesap oluşturma, herhangi bir oturumun
 * son görülmesi (soket bağlantısı / API kullanımı), kullanıcının gönderdiği son mesaj.
 */
const ACTIVITY_SQL = `
  SELECT u.id, u.handle, u.display_name, u.created_at,
         s.last_session_seen,
         m.last_message_at,
         COALESCE(m.message_count, 0) AS message_count,
         COALESCE(c.chat_count, 0)    AS chat_count,
         GREATEST(u.created_at, COALESCE(s.last_session_seen, u.created_at), COALESCE(m.last_message_at, u.created_at)) AS last_active_at
    FROM users u
    LEFT JOIN (SELECT user_id, MAX(last_seen_at) AS last_session_seen FROM sessions GROUP BY user_id) s ON s.user_id = u.id
    LEFT JOIN (SELECT sender_id, MAX(created_at) AS last_message_at, COUNT(*)::int AS message_count FROM messages GROUP BY sender_id) m ON m.sender_id = u.id
    LEFT JOIN (SELECT user_id, COUNT(*)::int AS chat_count FROM chat_members GROUP BY user_id) c ON c.user_id = u.id
`;

/** inactiveDays verilirse yalnızca o kadar gündür etkinliği olmayanlar; en eski etkinlik önce. */
async function listUsers({ inactiveDays = null, limit = 200, offset = 0 } = {}) {
  const params = [];
  let where = '';
  if (inactiveDays != null) {
    params.push(inactiveDays);
    where = `WHERE GREATEST(u.created_at, COALESCE(s.last_session_seen, u.created_at), COALESCE(m.last_message_at, u.created_at)) < now() - ($${params.length} || ' days')::interval`;
  }
  params.push(limit, offset);
  const r = await pool.query(
    `SELECT * FROM (${ACTIVITY_SQL} ${where}) x ORDER BY last_active_at ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params.map((p, i) => (i < (inactiveDays != null ? 1 : 0) ? String(p) : p)),
  );
  return r.rows;
}

async function stats() {
  const r = await pool.query(`
    SELECT (SELECT COUNT(*)::int FROM users) AS users,
           (SELECT COUNT(*)::int FROM chats) AS chats,
           (SELECT COUNT(*)::int FROM messages) AS messages,
           (SELECT COUNT(DISTINCT user_id)::int FROM sessions WHERE last_seen_at > now() - interval '30 days') AS active_30d,
           (SELECT COUNT(*)::int FROM reports WHERE status = 'OPEN') AS open_reports`);
  return r.rows[0];
}

/**
 * Kullanıcıları (ve bağlı her şeyi: oturumlar, anahtarlar, üyelikler, gönderdikleri
 * mesajlar, yedekler…) kalıcı olarak siler; ardından geride kalan boş / tek üyeli
 * birebir sohbetleri temizler. Tek transaction.
 * Dönüş: { deletedUsers, deletedChats, deletedMessages }
 */
async function deleteUsers(userIds, io = null) {
  if (!userIds.length) return { deletedUsers: 0, deletedChats: 0, deletedMessages: 0 };
  const client = await pool.connect();
  const notify = { left: [], changed: [] }; // [{ chatId, userId }] — commit sonrası soketle bildirilir
  try {
    await client.query('BEGIN');
    const touched = await client.query('SELECT DISTINCT chat_id FROM chat_members WHERE user_id = ANY($1::uuid[])', [userIds]);
    const chatIds = touched.rows.map((row) => row.chat_id);
    // Silinecek kişilerin dışında kalan üyeler: sohbet kalkarsa / üyelik değişirse onların telefonları da haberdar edilir.
    const remaining = chatIds.length
      ? (await client.query(
        'SELECT chat_id, user_id FROM chat_members WHERE chat_id = ANY($1::uuid[]) AND user_id <> ALL($2::uuid[])',
        [chatIds, userIds],
      )).rows
      : [];
    const msgs = await client.query('SELECT COUNT(*)::int AS n FROM messages WHERE sender_id = ANY($1::uuid[])', [userIds]);
    const del = await client.query('DELETE FROM users WHERE id = ANY($1::uuid[]) RETURNING id', [userIds]);
    let deletedChats = 0;
    if (chatIds.length) {
      const orphan = await client.query(
        `DELETE FROM chats c
          WHERE c.id = ANY($1::uuid[])
            AND ((SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id) = 0
                 OR (c.kind = 'DIRECT' AND (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id) < 2))
        RETURNING c.id`,
        [chatIds],
      );
      deletedChats = orphan.rowCount;
      const gone = new Set(orphan.rows.map((r) => r.id));
      // Yöneticisi kalmayan gruplarda en eski üye yönetici olur.
      await client.query(
        `UPDATE chat_members cm SET role = 'ADMIN'
          WHERE cm.chat_id = ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM chat_members a WHERE a.chat_id = cm.chat_id AND a.role = 'ADMIN')
            AND cm.user_id = (SELECT f.user_id FROM chat_members f WHERE f.chat_id = cm.chat_id ORDER BY f.joined_at, f.user_id LIMIT 1)
            AND EXISTS (SELECT 1 FROM chats g WHERE g.id = cm.chat_id AND g.kind = 'GROUP')`,
        [chatIds],
      );
      remaining.forEach((r) => (gone.has(r.chat_id) ? notify.left : notify.changed).push({ chatId: r.chat_id, userId: r.user_id }));
    }
    await client.query('COMMIT');
    if (io) {
      notify.left.forEach((n) => io.to(`user:${n.userId}`).emit('chat:left', { chatId: n.chatId }));
      notify.changed.forEach((n) => io.to(`user:${n.userId}`).emit('chat:members-changed', { chatId: n.chatId }));
    }
    return { deletedUsers: del.rowCount, deletedChats, deletedMessages: msgs.rows[0].n };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function findUserByHandleOrId(value) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const r = await pool.query(
    isUuid ? 'SELECT id, handle FROM users WHERE id = $1' : 'SELECT id, handle FROM users WHERE handle = lower($1)',
    [value],
  );
  return r.rows[0] || null;
}

/** Şikayet listesi (varsayılan: açık olanlar, en yeni önce). Kanıt medyası baytları dahil edilmez. */
async function listReports({ status = 'OPEN', limit = 100, offset = 0 } = {}) {
  const r = await pool.query(
    `SELECT r.id, r.reason, r.details, r.snapshot, r.status, r.resolution, r.created_at, r.resolved_at,
            r.chat_id, r.message_id, (r.evidence_media IS NOT NULL) AS has_evidence_media, r.evidence_mime,
            rep.handle AS reporter_handle, tgt.id AS target_id, tgt.handle AS target_handle, tgt.display_name AS target_name,
            (SELECT COUNT(*)::int FROM reports o WHERE o.target_user_id = r.target_user_id) AS target_report_count
       FROM reports r
       JOIN users rep ON rep.id = r.reporter_id
       JOIN users tgt ON tgt.id = r.target_user_id
      WHERE ($1::text IS NULL OR r.status = $1)
      ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
    [status === 'ALL' ? null : status, limit, offset],
  );
  return r.rows;
}

async function getReportEvidence(id) {
  const r = await pool.query('SELECT evidence_media, evidence_mime FROM reports WHERE id = $1', [id]);
  return r.rows[0] || null;
}

/**
 * Şikayeti sonuçlandırır. action: DISMISS (ihlal yok) | REMOVE_MESSAGE (mesajı herkesten sil) | DELETE_USER.
 * Kanıt medyası (yer kaplamasın diye) sonuçlandırılınca silinir. Dönüş: { report, removedMessage }.
 */
async function resolveReport(id, action, note, io = null) {
  const found = await pool.query('SELECT id, message_id, chat_id, target_user_id, status FROM reports WHERE id = $1', [id]);
  const report = found.rows[0];
  if (!report) return null;
  let removedMessage = null;
  if (action === 'REMOVE_MESSAGE' && report.message_id) {
    const del = await pool.query('DELETE FROM messages WHERE id = $1 RETURNING id, chat_id', [report.message_id]);
    removedMessage = del.rows[0] || null;
  }
  const status = action === 'DISMISS' ? 'DISMISSED' : 'ACTIONED';
  await pool.query(
    `UPDATE reports SET status = $2, resolution = $3, resolved_at = now(), evidence_media = NULL WHERE id = $1`,
    [id, status, [action, note].filter(Boolean).join(': ').slice(0, 500)],
  );
  let deleted = null;
  if (action === 'DELETE_USER') deleted = await deleteUsers([report.target_user_id], io);
  return { report: { id, status }, removedMessage, deleted };
}

module.exports = { listUsers, stats, deleteUsers, findUserByHandleOrId, listReports, getReportEvidence, resolveReport };
