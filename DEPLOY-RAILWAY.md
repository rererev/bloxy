# Deploy Bloxy ke Railway

## 1. Push ke GitHub
Ikuti langkah git biasa (`git init`, `git add .`, `git commit`, `git remote add origin ...`, `git push`).
File `.gitignore` udah disiapin biar `.env` (isi token/API key) **gak ikut ke-upload**.

## 2. Bikin project di Railway
1. Masuk ke railway.app, login (bisa pakai akun GitHub).
2. **New Project** → **Deploy from GitHub repo** → pilih repo Bloxy kamu.
3. Railway otomatis detect ini project Node.js (dari `package.json`) dan jalanin `npm install` + `npm start`. Gak perlu setting tambahan buat ini.

## 3. Isi Environment Variables
Di tab **Variables** project Railway, masukin SEMUA isi `.env` kamu satu-satu (copy dari `.env.example` sebagai acuan nama variabelnya, isi valuenya sesuai punya kamu — `DISCORD_TOKEN`, `GROQ_API_KEY`, dst).

## 4. PENTING — Setup Persistent Volume
Railway (defaultnya) **menghapus semua file yang ditulis bot sendiri** tiap kali re-deploy (`memory-data.json`, `reminders.json`, `slot-status.json`, `silence-state.json`, `access-schedule.json`). Kode-nya **udah disiapin** buat ini (lewat env var `DATA_DIR`), tinggal:

1. Di project Railway, buka tab **Settings** service-nya → cari **Volumes**.
2. **Add Volume**, mount ke path misal `/app/data`.
3. Di tab **Variables**, tambahin: `DATA_DIR=/app/data` (samain persis sama mount path di step 2).
4. Selesai — gak perlu ubah kode apapun lagi, bot otomatis nulis ke folder Volume itu.

Kalau `DATA_DIR` gak di-set sama sekali, bot otomatis pakai folder project sendiri (perilaku lama) — jadi aman buat Wispbyte, cuma relevan di Railway.

## 5. Cek Logs
Railway nyediain tab **Deployments** → **View Logs**, sama kayak log yang kamu lihat di Wispbyte — semua `console.log`/`console.error` yang udah kita pasang (PlayerMonitor, SlotAlert, DeleteLog, dst) bakal muncul di sana juga.

## File yang perlu ada di repo
- `index.js`
- `package.json` + `package-lock.json`
- `faq-data.json`
- `.gitignore`
- **JANGAN** commit `.env` (isi secret) — cuma `.env.example` yang boleh ikut
- File state (`memory-data.json`, `reminders.json`, `slot-status.json`, `silence-state.json`, `access-schedule.json`) — boleh ikut sebagai starting point kosong, isinya nanti ke-generate ulang sama bot
