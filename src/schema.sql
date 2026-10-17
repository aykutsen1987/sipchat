-- SipChat veritabanı şeması. Idempotent (tekrar çalıştırılabilir).

-- pgcrypto sağlar gen_random_uuid(); Render Postgres'te genelde hazır gelir.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    handle        TEXT UNIQUE NOT NULL,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chats (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          TEXT NOT NULL CHECK (kind IN ('DIRECT', 'GROUP')),
    title         TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_members (
    chat_id       UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, user_id)
);

-- Okundu bilgisi / okunmamış sayısı için: kullanıcının bu sohbette en son
-- ne zaman "okuduğu". Mevcut üyeler için varsayılan now() = hepsi okunmuş.
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS messages (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id       UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type          TEXT NOT NULL DEFAULT 'TEXT',
    text          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bu üç sütun sonradan eklendi (medya desteği). Tablo daha önce
-- oluşturulmuş bir dağıtımda da güvenle tekrar çalıştırılabilsin diye
-- ALTER ... IF NOT EXISTS kullanılıyor.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_data BYTEA;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_filename TEXT;

-- Her kullanıcının uçtan uca şifreleme için genel anahtarı (Tink hibrit
-- şifreleme keyset'i, base64). Sadece DIRECT sohbetlerde kullanılır — bkz.
-- Android tarafındaki E2eKeyManager.kt.
CREATE TABLE IF NOT EXISTS user_keys (
    user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    public_key    TEXT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Push bildirimleri için cihaz FCM token'ları. Bir kullanıcının birden
-- fazla cihazı olabileceğinden user_id başına çoklu satır.
CREATE TABLE IF NOT EXISTS push_tokens (
    token         TEXT PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform      TEXT NOT NULL DEFAULT 'android',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_members_user_id ON chat_members(user_id);
-- Kullanıcı engelleme. blocker_id, blocked_id ile mesajlaşamaz (tek yönlü
-- de olsa iki yönlü de kontrol edilir — bkz. realtime.js#isBlocked).
CREATE TABLE IF NOT EXISTS blocked_users (
    blocker_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked_id ON blocked_users(blocked_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens(user_id);

-- Gerçek, işlevsel kullanıcı tercihleri (Ayarlar ekranındaki anahtarlar).
-- Her kullanıcı kayıt olurken bir satır alır (bkz. auth.routes.js#register),
-- bu yüzden sorgularda her zaman var olduğu varsayılabilir.
CREATE TABLE IF NOT EXISTS user_settings (
    user_id                       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    read_receipts_enabled         BOOLEAN NOT NULL DEFAULT true,
    show_last_seen                BOOLEAN NOT NULL DEFAULT true,
    message_previews_enabled      BOOLEAN NOT NULL DEFAULT true,
    disappearing_default_seconds  INTEGER,
    two_factor_enabled            BOOLEAN NOT NULL DEFAULT false,
    two_factor_secret             TEXT,
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Bağlı Cihazlar" ekranı için gerçek oturum takibi. JWT'ye gömülen "sid"
-- claim'i buradaki id ile eşleşir; bir satır revoked_at alırsa o token
-- requireAuth middleware'inde reddedilir (bkz. middleware/auth.js).
CREATE TABLE IF NOT EXISTS sessions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name   TEXT NOT NULL DEFAULT 'Bilinmeyen cihaz',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Kaybolan mesajlar: sohbet bazlı, saniye cinsinden ömür. NULL = kapalı.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS disappear_seconds INTEGER;

-- Profil fotoğrafı: baytlar DB'de tutulur (media gibi), avatar_url bu baytları
-- sunan GET /api/users/:id/avatar adresine işaret eder.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime TEXT;

-- 2FA yedek kodları. Kodun kendisi saklanmaz, yalnızca HMAC özeti saklanır;
-- bir kod kullanıldığında used_at dolar ve bir daha kabul edilmez.
CREATE TABLE IF NOT EXISTS two_factor_backup_codes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash     TEXT NOT NULL,
    used_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_2fa_backup_user ON two_factor_backup_codes(user_id);

-- Şifreli bulut yedeği: kullanıcı başına tek slot. İçerik istemcide kullanıcının
-- parolasından türetilen anahtarla şifrelenir; sunucu yalnızca anlamsız bayt görür.
CREATE TABLE IF NOT EXISTS user_backups (
    user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data          BYTEA NOT NULL,
    size_bytes    INTEGER NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2FA kaba kuvvet kilidi: sunucu yeniden başlasa ya da birden fazla instance
-- çalışsa da herkes için aynı sayacı paylaşır.
CREATE TABLE IF NOT EXISTS two_factor_attempts (
    user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    fail_count    INTEGER NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Durumlar (24 saatlik paylaşımlar). İçerik uçtan uca şifrelidir: sunucu yalnızca
-- şifreli yük ve her izleyiciye ayrı sarılmış anahtarı saklar.
-- ---------------------------------------------------------------------------
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS status_visibility TEXT NOT NULL DEFAULT 'ALL'; -- ALL | EXCEPT | ONLY

CREATE TABLE IF NOT EXISTS status_privacy_users (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, contact_id)
);

CREATE TABLE IF NOT EXISTS statuses (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('TEXT', 'IMAGE')),
    payload_enc  TEXT NOT NULL,          -- AES-GCM(base64) metin/başlık/arka plan JSON'u
    media_data   BYTEA,                  -- AES-GCM şifreli görsel baytları
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_statuses_user ON statuses(user_id);
CREATE INDEX IF NOT EXISTS idx_statuses_expires ON statuses(expires_at);

CREATE TABLE IF NOT EXISTS status_keys (
    status_id    UUID NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
    viewer_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wrapped_key  TEXT NOT NULL,          -- içerik anahtarı, izleyicinin açık anahtarıyla sarılı
    PRIMARY KEY (status_id, viewer_id)
);
CREATE INDEX IF NOT EXISTS idx_status_keys_viewer ON status_keys(viewer_id);

CREATE TABLE IF NOT EXISTS status_views (
    status_id  UUID NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
    viewer_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (status_id, viewer_id)
);

-- Arama geçmişi
CREATE TABLE IF NOT EXISTS call_logs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    caller_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    callee_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id           UUID REFERENCES chats(id) ON DELETE SET NULL,
    call_type         TEXT NOT NULL DEFAULT 'AUDIO',
    status            TEXT NOT NULL DEFAULT 'MISSED',   -- MISSED | ANSWERED | DECLINED
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    answered_at       TIMESTAMPTZ,
    ended_at          TIMESTAMPTZ,
    hidden_by_caller  BOOLEAN NOT NULL DEFAULT false,
    hidden_by_callee  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs(caller_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_callee ON call_logs(callee_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Google ile giriş + e-posta eşleştirme
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
-- Anahtarlı özet (HMAC); düz e-posta eşleştirme için kullanılmaz.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hash TEXT;
-- Varsayılan KAPALI: kullanıcı açıkça katılmadıkça kimse onu e-postasıyla eşleştiremez.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_matching_enabled BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash) WHERE email_hash IS NOT NULL;

-- Kullanıcının "tanıdığım e-postalar" listesi: yalnızca anahtarlı özetler saklanır.
CREATE TABLE IF NOT EXISTS contact_hashes (
    user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hash     TEXT NOT NULL,
    PRIMARY KEY (user_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_contact_hashes_hash ON contact_hashes(hash);

-- Google ile açılan hesapların bilinen bir parolası yoktur (rastgele özet); silme gibi hassas işlemlerde
-- parola yerine taze bir Google doğrulaması istenir.
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_password BOOLEAN NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- Parola sıfırlama (kurtarma anahtarı), mesaj yanıt/iletme/düzenleme,
-- grup yöneticileri + grup fotoğrafı, şikayetler
-- ---------------------------------------------------------------------------

-- Kurtarma anahtarı: kayıtta bir kez gösterilir; yalnızca anahtarlı özeti (HMAC) saklanır.
-- Parolasını unutan kullanıcı bu anahtarla (ücretsiz, e-posta/SMS gerektirmeden) parolasını yeniler.
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_created_at TIMESTAMPTZ;

-- Parola sıfırlama kaba kuvvet kilidi (2FA kilidiyle aynı mantık, ayrı sayaç).
CREATE TABLE IF NOT EXISTS password_reset_attempts (
    user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    fail_count    INTEGER NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Yanıtla / ilet / düzenle.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;

-- Grup yöneticileri ve grup fotoğrafı.
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'MEMBER'; -- ADMIN | MEMBER
ALTER TABLE chats ADD COLUMN IF NOT EXISTS photo_data BYTEA;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS photo_mime TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Yöneticisi olmayan mevcut gruplarda en eski üye yönetici olur (tekrar çalıştırmak zararsızdır).
UPDATE chat_members cm SET role = 'ADMIN'
 WHERE cm.role = 'MEMBER'
   AND cm.chat_id IN (SELECT id FROM chats WHERE kind = 'GROUP')
   AND NOT EXISTS (SELECT 1 FROM chat_members a WHERE a.chat_id = cm.chat_id AND a.role = 'ADMIN')
   AND cm.user_id = (SELECT f.user_id FROM chat_members f WHERE f.chat_id = cm.chat_id ORDER BY f.joined_at, f.user_id LIMIT 1);

-- Şikayetler (kullanıcı ya da mesaj). Mesaj silinse bile kanıt kalsın diye anlık görüntü saklanır.
CREATE TABLE IF NOT EXISTS reports (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id          UUID REFERENCES chats(id) ON DELETE SET NULL,
    message_id       UUID,
    reason           TEXT NOT NULL,
    details          TEXT,
    snapshot         JSONB,
    evidence_media   BYTEA,
    evidence_mime    TEXT,
    status           TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN | DISMISSED | ACTIONED
    resolution       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_user_id);

-- ---------------------------------------------------------------------------
-- Kişiler (rehber): "Yeni sohbet" ekranında listelenen kayıtlı kişiler.
-- Elle eklenenler + birebir sohbette ilk mesajlaşılanlar. İlk kurulumda mevcut birebir sohbetlerin
-- karşı tarafları eklenir (yalnızca tablo ilk kez oluşurken; sonra silinen kişi geri gelmez).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'contacts') THEN
    CREATE TABLE contacts (
      owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, contact_id)
    );
    CREATE INDEX idx_contacts_owner ON contacts(owner_id);
    INSERT INTO contacts (owner_id, contact_id)
    SELECT a.user_id, b.user_id
      FROM chat_members a
      JOIN chat_members b ON a.chat_id = b.chat_id AND a.user_id <> b.user_id
      JOIN chats c ON c.id = a.chat_id AND c.kind = 'DIRECT'
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- SipChat 13 yaş ve üzeri içindir: kayıtta yaş beyanı zorunludur ve zamanı saklanır
-- (eski hesaplar uygulamada bir kez onaylar: POST /api/auth/age-confirm).
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_confirmed_at TIMESTAMPTZ;
