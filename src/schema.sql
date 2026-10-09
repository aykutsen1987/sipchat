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
