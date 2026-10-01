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
