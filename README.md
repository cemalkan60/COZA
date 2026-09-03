# MadeIn — Zara Woman Tedarik İzleyici

MadeIn, Zara Woman koleksiyonunu izleyen; ürün kataloğu, kapsamlı arama, gerçek
üretim yeri ("Made in") bilgisi, üretici kodu bazlı analiz, favoriler ve ürün
karşılaştırma sunan **Türkçe** bir mobil uygulamadır. Kapalı bir giriş sistemi
(auth wall) ile yalnızca önceden tanımlı 5 kullanıcı erişebilir.

## Teknoloji Yığını

| Katman     | Teknoloji                                             |
|------------|-------------------------------------------------------|
| Frontend   | Expo (React Native) + Expo Router, TypeScript         |
| Navigasyon | React Navigation Drawer (hamburger menü)              |
| Backend    | FastAPI (Python), JWT + bcrypt auth, APScheduler      |
| Veritabanı | MongoDB (motor async driver)                          |
| Veri kaynağı | Zara ES (zara.com/es/en) ScraperAPI proxy üzerinden |

## Özellikler

- **Katalog**: ~4.600+ Zara Woman ürünü; kapsamlı arama (ad / kategori / menşe /
  renk / üretici kodu), sonsuz kaydırma, gerçek üretim yeri rozeti.
- **Hamburger menü**: Katalog, Yeni Gelenler, Analiz, Favoriler, Profil +
  Kategoriler ve Üretim Yeri filtreleri.
- **Analiz**: Üretici koduna göre menşe/kategori dağılımı + genel bakış.
- **Yeni Gelenler**, **Favoriler**, **Ürün Karşılaştırma** (2 ürün, kompozisyon dahil).
- **Kapalı giriş (auth wall)**: yalnızca 5 sabit kullanıcı; kayıt kapalı.
- **Otomatik görev**: her **Pazartesi ve Perşembe 08:00** (Europe/Istanbul)
  otomatik tarama + gerçek üretim yeri zenginleştirme.
- Koyu / açık tema.

## Proje Yapısı

```
/app
├── backend
│   ├── server.py          # FastAPI uygulaması, API'ler, scheduler, auth
│   ├── scraper.py         # Zara ES katalog + origin/kompozisyon çekimi
│   ├── requirements.txt
│   ├── .env               # gizli değerler (commit edilmez)
│   └── .env.example
└── frontend
    ├── app/               # Expo Router ekranları (dosya bazlı yönlendirme)
    │   ├── (auth)/        # login
    │   ├── (tabs)/        # drawer: katalog, yeni, analiz, favoriler, profil
    │   ├── product/, factory/, compare.tsx
    ├── src/               # api, components, context, theme, utils
    ├── .env
    └── .env.example
```

## Kurulum

### 1. Ortam değişkenleri

```bash
cp backend/.env.example backend/.env       # değerleri doldurun
cp frontend/.env.example frontend/.env
```

- `JWT_SECRET` üretmek için: `openssl rand -hex 32`
- `SCRAPER_API_KEY`: https://www.scraperapi.com adresinden alınır.
- `SEED_*` değerleri kapalı giriş sistemindeki 5 kullanıcıyı belirler.

### 2. Backend

```bash
cd backend
pip install -r requirements.txt
# supervisor ile yönetilir:
sudo supervisorctl restart backend
```

Backend `0.0.0.0:8001` üzerinde çalışır ve tüm rotalar `/api` ön ekiyle sunulur.

### 3. Frontend

```bash
cd frontend
yarn install
sudo supervisorctl restart expo
```

## Kimlik Doğrulama (Kapalı Sistem)

- Kayıt olma (signup) **kapalıdır** — `POST /api/auth/login` yalnızca 5 sabit
  kullanıcıyı kabul eder. Uygulama her açılışta listede olmayan hesapları siler.
- **Yönetici** (`cem`): proxy anahtarı/ayarlar, elle tarama, üretim yeri
  zenginleştirme yetkisine sahiptir.
- **Gözlemciler** (`ece`, `burak`, `beyza`, `ferdi`): salt okuma; yönetici
  uç noktalarında 403 alır.
- JWT bearer token kullanılır: `Authorization: Bearer <token>`.

## Başlıca API Uç Noktaları

| Uç nokta | Açıklama |
|----------|----------|
| `POST /api/auth/login` | Giriş (token + kullanıcı döner) |
| `GET  /api/auth/me` | Mevcut kullanıcı |
| `GET  /api/products` | Filtreler: category, origin, code, q, is_new, price, sort |
| `GET  /api/products/{id}` | Ürün detayı |
| `GET  /api/products/{id}/composition` | Kompozisyon (canlı çekim + cache) |
| `GET  /api/filters` | Kategori/menşe filtre listeleri |
| `GET  /api/analytics` | Genel katalog analizi |
| `GET  /api/manufacturers?q=` | Üretici kodu araması |
| `GET  /api/analytics/manufacturer/{code}` | Üretici bazlı analiz |
| `GET  /api/meta` | Ürün sayısı, son tarama, bilinen menşe sayısı |
| `POST /api/admin/scrape` | Elle tarama (yalnız admin) |
| `POST /api/admin/enrich-origins` | Üretim yeri zenginleştirme (yalnız admin) |
| `GET/PUT /api/admin/settings` | Proxy anahtarı / ayarlar (yalnız admin) |

## Zamanlanmış Görev

APScheduler (`Europe/Istanbul`) her **Pazartesi ve Perşembe 08:00**'de tarama +
üretim yeri zenginleştirme çalıştırır (`CronTrigger(day_of_week="mon,thu", hour=8)`).

## Dağıtım (Deployment)

Bu ortam bir **önizleme/geliştirme** ortamıdır. Yayına almak ve iOS/Android
build oluşturmak için sağ üstteki **Publish → Deploy your app → Generate iOS and
Android builds** akışını kullanın. Bildirim, kamera, ses gibi bazı native
özellikler yalnızca gerçek cihaz build'inde test edilebilir.

## Notlar

- Gizli değerler yalnızca `.env` dosyalarında tutulur; `*.env.example` dosyaları
  yalnızca yer tutucu içerir ve versiyon kontrolüne eklenebilir.
- Frontend'de yalnızca `EXPO_PUBLIC_*` değişkenleri istemciye açılır — buraya
  asla gizli anahtar konmaz.
