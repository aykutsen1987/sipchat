# SipChat Backend

Express + Socket.IO + PostgreSQL ile yazılmış, SipChat Android uygulamasının
gerçek zamanlı mesajlaşma altyapısını sağlayan **ayrı** bir backend
projesidir. Bu klasör Android projesinden bağımsızdır — kendi GitHub
deposuna yüklenip Render'da ayrı olarak deploy edilir.

## Güvenlik Özeti

- Şifreler **bcrypt** (cost 12) ile hash'lenir, asla düz metin saklanmaz.
- Kimlik doğrulama **JWT** ile yapılır; REST istekleri `Authorization: Bearer`
  header'ı, Socket.IO bağlantıları ise handshake sırasında aynı token'ı
  gerektirir — token'sız hiçbir istek/soket kabul edilmez.
- **Helmet** ile güvenlik HTTP başlıkları, **express-rate-limit** ile
  brute-force/DoS koruması (özellikle `/api/auth` uçlarında daha sıkı).
- Girişler **express-validator** ile doğrulanır; SQL sorguları parametreli
  (`$1, $2, ...`) çalıştırılır — SQL injection'a kapalıdır.
- Render tüm servislere otomatik **HTTPS/TLS** sağlar.
- `.env` dosyası `.gitignore` ile hariç tutulmuştur — sırlarınız asla
  GitHub'a gitmez.

> Not: Bu, **transport ve hesap güvenliğini** kapsar. Gerçek "uçtan uca
> şifreleme" (mesaj içeriğinin sunucunun bile okuyamayacağı şekilde
> şifrelenmesi) ayrı bir konudur ve istemci tarafında (Android uygulaması
> içinde) ayrıca uygulanmalıdır — bkz. Android projesinin README.md'sindeki
> yol haritası.

---

## Adım Adım: GitHub'a Yükleme ve Render'da Yayınlama

### Adım 1 — Bu klasörü GitHub'a yükleyin
```bash
cd sipchat-backend
git init
git add .
git commit -m "SipChat backend ilk sürüm"
git branch -M main
git remote add origin https://github.com/KULLANICI_ADINIZ/sipchat-backend.git
git push -u origin main
```
(`KULLANICI_ADINIZ` kısmını kendi GitHub kullanıcı adınızla değiştirin ve
önce GitHub üzerinde boş bir `sipchat-backend` deposu oluşturun.)

### Adım 2 — Render hesabı açın
[render.com](https://render.com) adresine GitHub hesabınızla giriş yapın.

### Adım 3 — Blueprint ile tek seferde kurun (önerilen)
Bu depoda `render.yaml` dosyası hazır — Render bunu otomatik algılar:
1. Render Dashboard → **New** → **Blueprint**
2. GitHub'daki `sipchat-backend` deposunu seçin
3. Render, hem **Web Service** (backend) hem **ücretsiz PostgreSQL**
   veritabanını otomatik oluşturur ve `DATABASE_URL`'i kendisi bağlar.
4. **Apply** deyin — ilk deploy başlar (birkaç dakika sürer).

*(Blueprint kullanmak istemezseniz: Dashboard → New → Web Service ile
manuel de kurabilirsiniz; bu durumda "Adım 4"teki env değişkenlerini elle
girmeniz gerekir.)*

### Adım 4 — Ortam değişkenlerini kontrol edin
Render → servisiniz → **Environment** sekmesinde şunlar olmalı:
- `DATABASE_URL` → Blueprint kullandıysanız otomatik dolu
- `JWT_SECRET` → Blueprint otomatik güvenli bir değer üretir
- `JWT_EXPIRES_IN` → `7d` (isteğe bağlı değiştirin)
- `ALLOWED_ORIGINS` → boş bırakabilirsiniz (mobil istemciler etkilenmez)

### Adım 5 — Veritabanı şeması (otomatik, yapacak bir şey yok)
Render'ın **ücretsiz planı Shell/SSH erişimini desteklemiyor**, bu yüzden
`npm run migrate`'i elle çalıştırmanıza gerek kalmasın diye `package.json`
içindeki `start` komutu, sunucu her başladığında (ilk deploy, her yeniden
deploy, ücretsiz plandaki her "uykudan uyanma") önce şemayı otomatik
uygulayacak şekilde ayarlandı:
```json
"start": "node src/migrate.js && node src/index.js"
```
`schema.sql` tamamen güvenli bir şekilde tekrar tekrar çalışacak yazıldığı
(`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) için bu, her
başlangıçta birkaç saniye sürer ve veri kaybına yol açmaz. Render Logs'ta
şunu görmelisiniz:
```
Applying schema.sql ...
Schema applied successfully.
SipChat backend listening on port ...
```
Ücretli bir plana geçip Shell erişiminiz olursa, `npm run migrate`'i yine
elle de çalıştırabilirsiniz — ikisi de aynı işi yapar.

### Adım 6 — Render URL'inizi alın
Deploy tamamlanınca servisinizin üstünde şuna benzer bir adres görünür:
```
https://sipchat-backend-xxxx.onrender.com
```
Bu adresi kopyalayın.

### Adım 7 — Android uygulamasına URL'i tanıtın
SipChat Android projesinde
`app/src/main/java/com/sipchat/app/core/NetworkConfig.kt` dosyasını açın ve
`BASE_URL` sabitini Adım 6'da aldığınız adresle değiştirin:
```kotlin
const val BASE_URL = "https://sipchat-backend-xxxx.onrender.com/"
```
Değiştirip uygulamayı yeniden derlediğinizde uygulama bu backend'e
bağlanmaya hazır hale gelir (detaylı entegrasyon adımları Android
projesinin README.md dosyasındaki yol haritasında).

### Adım 8 — Test edin
```bash
curl https://sipchat-backend-xxxx.onrender.com/health
# {"status":"ok"}

curl -X POST https://sipchat-backend-xxxx.onrender.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"handle":"testuser","displayName":"Test User","password":"sifre1234"}'

# Yukarıdaki yanıtta dönen "token" değerini kullanarak profilinizi doğrulayın:
curl https://sipchat-backend-xxxx.onrender.com/api/auth/me \
  -H "Authorization: Bearer BURAYA_TOKEN"
```

---

### Sohbet Oluşturma, Kullanıcı Arama, Okundu Bilgisi
Daha önce sohbet listesi vardı ama **yeni sohbet başlatan bir uç nokta
yoktu**. Artık var:
- `GET /api/users/search?q=...` — kullanıcı adı/isimle arama (kendinizi
  hariç tutar, en az 2 karakter).
- `POST /api/chats` — `{"type":"DIRECT","userId":"..."}` ile birebir sohbet
  (zaten varsa mevcut olanı döndürür) veya
  `{"type":"GROUP","title":"...","memberIds":["...","..."]}` ile grup kurar.
- `POST /api/chats/:chatId/read` — "buraya kadar okudum" işaretler; karşı
  tarafın istemcisinde çift tik maviye döner.
- `DELETE /api/chats/:chatId/messages/:messageId` — yalnızca kendi
  mesajınızı, herkes için siler.
- Çevrimiçi/çevrimdışı durumu artık gerçek: bir kullanıcının canlı soket
  bağlantısı olup olmadığına göre hesaplanır ve `presence:update` ile
  ortak sohbeti olan herkese anlık yayınlanır.

## Yeni Özellikler (Room, Medya, Push, Arama, E2E Şifreleme)

### Şema güncellemesi gerekiyor mu?
Hayır — bu özellikler `messages` tablosuna yeni sütunlar ve yeni tablolar
(`user_keys`, `push_tokens`, `blocked_users` vb.) ekliyor, ama Adım 5'te
anlatıldığı gibi şema her sunucu başlangıcında otomatik uygulanıyor. Yeni
bir deploy yapıp servis yeniden başladığında bu yeni tablo/sütunlar da
otomatik oluşur, elle bir şey yapmanıza gerek yok.

### Medya Gönderimi
`POST /api/chats/:chatId/media` (multipart, alan adı `file`, 8 MB üst
sınır) ile fotoğraf/dosya/sesli mesaj yüklenir; MIME türüne göre otomatik
IMAGE/FILE/VOICE olarak sınıflandırılır (sesli mesajlarda ek bir
`duration` alanı, ör. "0:12", `text` sütununda saklanır). bytea olarak
doğrudan Postgres'te saklanır (ayrı bir depolama servisi — S3 vb. —
gerekmez). `GET /api/media/:messageId` ile geri servis edilir; yalnızca o
sohbetin üyesi indirebilir (Bearer token zorunlu).

**Sınır:** Render'ın ücretsiz Postgres'i belirli bir disk kotasına sahiptir;
çok sayıda/büyük medya biriktirmek bu kotayı hızla tüketebilir — üretimde
gerçek bir obje depolama servisine (S3, Cloudflare R2 vb.) geçmeniz
önerilir.

### Push Bildirimleri (Firebase Cloud Messaging)
Sunucu tarafı `firebase-admin` ile çalışır ama **siz bir Firebase projesi
oluşturup servis hesabı anahtarını tanımlamadan hiçbir şey göndermez** —
yapılandırılmamışsa sessizce devre dışı kalır, hiçbir şeyi bozmaz.

1. [Firebase Console](https://console.firebase.google.com) → yeni proje.
2. Proje ayarları → **Service accounts** → **Generate new private key** →
   inen JSON dosyasını açın.
3. İçeriğini base64'e çevirin (Windows PowerShell):
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))
   ```
4. Render → servisiniz → **Environment** → yeni değişken ekleyin:
   `FIREBASE_SERVICE_ACCOUNT_JSON` = (yukarıdaki base64 çıktısı)
5. Android tarafında aynı Firebase projesinden **Android uygulaması** ekleyip
   (paket adı: `com.sipchat.app`) inen `google-services.json` dosyasını
   `SipChat/app/` klasörüne koyun ve `NetworkConfig.PUSH_ENABLED = true`
   yapın (bkz. Android README'sinin "Push Bildirimleri" bölümü).

### Sesli/Görüntülü Arama
Bu backend, iki taraf arasında SDP teklif/yanıt ve ICE aday bilgilerini
Socket.IO üzerinden **iletir** (`call:invite`, `call:answer`,
`call:ice-candidate`, `call:decline`, `call:end`) — ses/görüntü verisinin
kendisi asla bu sunucudan geçmez, doğrudan iki cihaz arasında akar. Android
tarafında artık gerçek bir WebRTC istemcisi var (`RealWebRtcClient`,
`io.getstream:stream-webrtc-android`) — mikrofon/kamera yakalanıyor, ses ve
(video aramada) görüntü gerçekten iletiliyor. Varsayılan olarak yalnızca
Google'ın herkese açık STUN sunucusu (`stun:stun.l.google.com:19302`)
kullanılıyor.

**Önemli sınır:** STUN, çoğu ev/ofis ağında NAT arkasındaki iki cihazın
birbirini bulmasına yeter, ama simetrik NAT/kurumsal güvenlik duvarı gibi
durumlarda çalışmaz — bunun için bir **TURN** sunucusu (ör. coturn'ü kendi
sunucunuzda barındırmak, ya da Twilio/Metered gibi ücretli bir TURN
servisi) eklemeniz gerekir. Bu proje bunu **bilerek içermiyor** (ekleme
tamamlandı, TURN ayrı bırakıldı); Android tarafındaki
`data/call/RealWebRtcClient.kt` içindeki `iceServers` listesine eklemek
için net bir yer var.

### Uçtan Uca Şifreleme (E2E)
`PUT /api/users/me/key` ile herkese açık anahtarınızı, `GET
/api/chats/:chatId/peer-key` ile DIRECT bir sohbetteki karşı tarafın genel
anahtarını alırsınız. Sunucu **yalnızca genel anahtarları ve şifreli
metni** görür — düz metni asla göremez. Bu, yalnızca **DIRECT (1:1)**
sohbetler için geçerlidir; grup sohbetlerinde mesajlar düz metin olarak
saklanır (grup E2E'si için her üyeye ayrı anahtar sarma gerekir, bu Signal
Protokolü seviyesinde ayrı bir iş — kapsam dışı bırakıldı).

## Ayarlar, Oturumlar ve İki Aşamalı Doğrulama

Android'deki Ayarlar ekranının her satırı artık gerçek bir uca bağlı:

| Uç nokta | Ne yapar |
|---|---|
| `GET /api/settings` | Kullanıcı tercihlerini döndürür (okundu bilgisi, son görülme, mesaj önizleme, varsayılan kaybolan mesaj süresi, 2FA durumu) |
| `PATCH /api/settings` | Yalnızca gönderilen alanları günceller |
| `GET /api/sessions` | Oturum açık cihazlar (cihaz adı, son görülme, "bu cihaz" işareti) |
| `DELETE /api/sessions/:id` | O cihazın token'ını geçersiz kılar — sonraki isteğinde 401 alır |
| `POST /api/auth/2fa/setup` | Yeni bir TOTP sırrı + `otpauth://` URI'si üretir (henüz etkin değil) |
| `POST /api/auth/2fa/enable` `{code}` | Uygulamadan gelen 6 haneli kodla doğrular ve etkinleştirir |
| `POST /api/auth/2fa/disable` `{code}` | Geçerli bir kod gerektirir |
| `POST /api/auth/2fa/verify-login` | 2FA açıkken girişin ikinci adımı |

**Bu ayarlar sunucuda gerçekten uygulanır**, sadece arayüzde saklanmaz:
- *Okundu bilgisi kapalı* → o kullanıcı için `read_by_peer` hiçbir zaman `true` dönmez.
- *Son görülme kapalı* → `presence:update` olayı hiç yayınlanmaz, sohbet listesinde `peer_online` her zaman `false` olur.
- *Mesaj önizleme kapalı* → o alıcıya giden push bildiriminde gönderen adı/içerik yerine "Yeni bir mesajınız var" yazar.
- *Kaybolan mesajlar* → sunucu her 60 saniyede süresi dolan mesajları siler ve bağlı istemcilere `message:deleted` olayı gönderir.
- *Oturum iptali* → `requireAuth` her istekte `sessions` tablosuna bakar. Bu özellikten önce üretilmiş (`sid` claim'i olmayan) token'lar çalışmaya devam eder, veritabanı geçici olarak yanıt vermezse de erişim engellenmez — bu kontrol tüm API'yi düşürmesin diye bilerek "açık-hata" (fail-open) yazıldı.

**2FA notları:**
- TOTP algoritması bağımlılıksız, yalnızca Node'un yerleşik `crypto` modülüyle (HMAC-SHA1) yazıldı ve RFC 6238 Ek B'deki resmi test vektörüyle doğrulandı (`src/totp.js`).
- Giriş sırasında 2FA açıksa sunucu token yerine 5 dakika geçerli, yalnızca `/2fa/verify-login` tarafından kabul edilen bir `pendingToken` döndürür.
- **Yedek kodlar yok**: kimlik doğrulama uygulamasını kaybeden kullanıcı için hesap kurtarma akışı bulunmuyor. Üretimde mutlaka eklenmeli.

## Render Ücretsiz (512 MB) Planının Sınırları — Kısa Hatırlatma

- Servis 15 dakika hareketsizlikte **uykuya dalar**; ilk istek birkaç saniye
  gecikebilir (cold start).
- Ücretsiz PostgreSQL belirli bir süre sonra **silinme politikasına**
  tabidir — üretim (production) verisi için uygun değildir, sadece
  geliştirme/demo için düşünün.
- 512 MB RAM ile eşzamanlı çok sayıda WebSocket bağlantısını (yüzlerce+
  kullanıcı) kaldırmayabilir; büyüdükçe ücretli plana geçin.

## Yerel Geliştirme

```bash
npm install
cp .env.example .env   # değerleri doldurun (yerel bir Postgres gerekir)
npm run migrate
npm run dev
```
