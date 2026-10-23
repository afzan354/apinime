# 🚀 AnibiPlay API v1.0 — Versi JavaScript (Vercel Serverless)

Versi JavaScript (Node.js/Express) dari AnibiPlay API yang dirancang khusus untuk di-deploy ke **Vercel** dan dikonsumsi langsung oleh **Aplikasi Android (file APK)**.

---

## 📁 Struktur Folder `vercel/`

```
vercel/
├── api/
│   └── index.js              ← Entry point utama Vercel Serverless Function & local server
├── src/
│   ├── db.js                 ← Connection pool MySQL (mendukung TiDB Cloud, Aiven, lokal)
│   ├── helpers.js            ← Formatter rules.md, ETag, 304, caching, & error handler
│   ├── scraper.js            ← Scraper engine (Cheerio & Axios) untuk anichin.moe
│   └── routes/
│       ├── home.js           ← GET /api/v1/home
│       ├── series.js         ← GET /api/v1/series, /series/:id, /series/:id/episodes
│       ├── play.js           ← POST & GET /api/v1/series/:id/episodes/:n/play
│       ├── schedule.js       ← GET /api/v1/schedule
│       ├── search.js         ← GET /api/v1/search?q=
│       ├── genres.js         ← GET /api/v1/genres
│       ├── progress.js       ← GET & PUT /api/v1/me/progress
│       └── health.js         ← GET /api/v1/health
├── .env.example              ← Template environment variable
├── .gitignore
├── vercel.json               ← Konfigurasi rewrite serverless Vercel
├── package.json              ← Dependensi Node.js
└── README.md
```

---

## 💻 1. Menjalankan di Lokal (Testing)

Sebelum di-upload ke Vercel, kamu bisa mengujinya langsung di laptop/PC:

1. **Buka terminal di dalam folder `vercel`**:
   ```bash
   cd d:\laragon\www\archive\2026\10_oktober\4_api\vercel
   ```

2. **Install dependensi**:
   ```bash
   npm install
   ```

3. **Buat file `.env`**:
   Salin `.env.example` menjadi `.env`. Jika memakai MySQL bawaan Laragon di PC lokal:
   ```env
   PORT=3000
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_USER=root
   DB_PASS=
   DB_NAME=anichin_api
   DB_SSL=false
   SOURCE_BASE_URL=https://anichin.moe
   ```

4. **Jalankan server**:
   ```bash
   npm run dev
   ```
   Akses di browser: `http://localhost:3000/api/v1/home` atau `http://localhost:3000/api/v1/health`.

---

## ☁️ 2. Persiapan Database Cloud (Wajib untuk Vercel)

Karena Vercel sifatnya *stateless* (tidak memiliki database MySQL lokal di dalamnya), kamu memerlukan database MySQL online gratis agar Vercel bisa membaca data anime.

### Rekomendasi Database MySQL Gratis:
1. **TiDB Cloud Serverless (Sangat Direkomendasikan)**:
   - Gratis 5 GB penyimpanan, kompatibel 100% dengan MySQL 8.0.
   - Buka: [https://tidbcloud.com](https://tidbcloud.com)
   - Buat cluster **Serverless** gratis.
   - Buka menu **SQL Editor**, lalu jalankan isi file `../database.sql` untuk membuat tabel-tabelnya.
   - Salin kredensial koneksi (Host, User, Password, Port).
   - Set `DB_SSL=true` di konfigurasi environment.

2. **Aiven for MySQL**:
   - Gratis tier cloud database.
   - Buka: [https://aiven.io](https://aiven.io)

---

## 🚀 3. Cara Upload / Deploy ke Vercel

Ada dua cara mudah untuk deploy:

### Cara A: Lewat GitHub (Otomatis & Paling Mudah)
1. Buat repository baru di akun GitHub Anda (misal: `anibiplay-api`).
2. Masukkan isi folder `vercel/` ke dalam repo tersebut:
   ```bash
   cd d:\laragon\www\archive\2026\10_oktober\4_api\vercel
   git init
   git add .
   git commit -m "Initial commit AnibiPlay Vercel API"
   git branch -M main
   git remote add origin https://github.com/USERNAME/anibiplay-api.git
   git push -u origin main
   ```
3. Buka dashboard [https://vercel.com](https://vercel.com) dan klik **Add New Project**.
4. Import repository GitHub tadi.
5. Pada menu **Environment Variables**, masukkan variabel berikut:
   - `DB_HOST` : Host database cloud Anda (misal: `gateway01.ap-southeast-1.prod.aws.tidbcloud.com`)
   - `DB_PORT` : `4000` atau `3306`
   - `DB_USER` : User database cloud
   - `DB_PASS` : Password database cloud
   - `DB_NAME` : `anichin_api` (atau nama database Anda)
   - `DB_SSL`  : `true` (jika pakai TiDB Cloud / Aiven)
   - `SOURCE_BASE_URL` : `https://anichin.moe`
6. Klik **Deploy**!
7. Selesai! Kamu akan mendapatkan domain resmi HTTPS, misalnya:
   `https://anibiplay-api.vercel.app`

### Cara B: Lewat Vercel CLI (Langsung dari Terminal)
```bash
# Install Vercel CLI jika belum ada
npm i -g vercel

# Login dan deploy
cd d:\laragon\www\archive\2026\10_oktober\4_api\vercel
vercel
```

---

## 📱 4. Menghubungkan ke File APK Android

Di dalam source code Android Studio (APK) kamu (misal di file `Constants.java`, `RetrofitClient.kt`, atau `config.js` jika pakai React Native/Flutter):

Ganti basis URL lama:
```diff
- public static final String BASE_URL = "http://10.0.2.2/archive/2026/10_oktober/4_api/api/v1/";
+ public static final String BASE_URL = "https://anibiplay-api.vercel.app/api/v1/";
```

**Kelebihan untuk APK:**
- ✅ Langsung berprotokol **HTTPS (SSL)** sehingga tidak akan diblokir oleh Android 9, 10, 11, 12, 13, 14+.
- ✅ APK bisa di-build, di-export, dan langsung dibagikan ke teman tanpa perlu terhubung ke satu jaringan Wi-Fi lokal.
- ✅ Respon API sangat cepat karena di-cache di Edge CDN global Vercel.

---

## 📡 Daftar Endpoint API yang Tersedia

Semua endpoint mengembalikan respon JSON yang **100% sama** dengan versi PHP:

| Method | Endpoint | Deskripsi |
|---|---|---|
| `GET` | `/api/v1/home` | Beranda (featured, fresh, trending, newest) |
| `GET` | `/api/v1/series` | Katalog dengan filter `?genre=`, `?status=`, `?sort=`, `?page=` |
| `GET` | `/api/v1/series/:id` | Detail series + 5 episode terbaru (auto-scrape jika data kosong) |
| `GET` | `/api/v1/series/:id/episodes` | Daftar semua episode |
| `POST` & `GET` | `/api/v1/series/:id/episodes/:n/play` | Resolusi URL video pemutaran (Ok.ru, Mp4Upload, dll) |
| `GET` | `/api/v1/schedule` | Jadwal tayang mingguan (Senin–Minggu WIB) |
| `GET` | `/api/v1/search?q=kata` | Pencarian anime & donghua |
| `GET` | `/api/v1/genres` | Daftar genre beserta total judul |
| `GET` | `/api/v1/me/progress?token=xxx` | Ambil riwayat tontonan user |
| `PUT` | `/api/v1/me/progress` | Simpan riwayat tontonan (Header: `X-User-Token`) |
| `GET` | `/api/v1/health` | Tes latency upstream & koneksi DB |
