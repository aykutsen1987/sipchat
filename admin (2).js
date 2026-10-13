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
           (SELECT COUNT(DISTINCT user_id)::int FROM sessions WHERE last_seen_at > now() - interval '30 days') AS active_30d`);
  return r.rows[0];
}

/**
 * Kullanıcıları (ve bağlı her şeyi: oturumlar, anahtarlar, üyelikler, gönderdikleri
 * mesajlar, yedekler…) kalıcı olarak siler; ardından geride kalan boş / tek üyeli
 * birebir sohbetleri temizler. Tek transaction.
 * Dönüş: { deletedUsers, deletedChats, deletedMessages }
 */
async function deleteUsers(userIds) {
  if (!userIds.length) return { deletedUsers: 0, deletedChats: 0, deletedMessages: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const touched = await client.query('SELECT DISTINCT chat_id FROM chat_members WHERE user_id = ANY($1::uuid[])', [userIds]);
    const chatIds = touched.rows.map((row) => row.chat_id);
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
    }
    await client.query('COMMIT');
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

module.exports = { listUsers, stats, deleteUsers, findUserByHandleOrId };
