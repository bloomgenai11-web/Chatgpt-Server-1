#!/bin/bash
set -e

echo "[SETUP] Inisialisasi Codespace (gateway + bot_github)..."

# 1. package.json
if [ ! -f "package.json" ]; then
  echo "[SETUP] Membuat package.json dasar..."
  npm init -y
fi

# 2. Display virtual + library grafis (Camoufox / WebGL / Xvfb)
echo "[SETUP] Menginstal Xvfb dan dependensi grafis..."
sudo apt-get update
sudo apt-get install -y xvfb libgl1 libglx-mesa0 libosmesa6 wget curl ca-certificates

# 3. NPM — paket lama + yang BARU untuk sistem terbaru
echo "[SETUP] Membersihkan puppeteer lama (jika ada)..."
npm uninstall puppeteer-core puppeteer-extra puppeteer-extra-plugin-stealth 2>/dev/null || true

echo "[SETUP] Instal dependensi NPM..."
# Lama (sudah ada di setup awal):
#   express cors @upstash/redis camoufox-js playwright
# BARU wajib:
#   dotenv  — gateway.js + bot_github.js baca .env
npm install express cors @upstash/redis camoufox-js playwright dotenv
npm install -g pm2

# 4. Dependensi OS Firefox/Playwright
echo "[SETUP] Playwright install-deps firefox..."
npx playwright install-deps firefox || true

# 5. Biner Camoufox
echo "[SETUP] Mengunduh biner Camoufox..."
npx camoufox-js fetch

# 6. Folder kerja
mkdir -p hasil_media temp_uploads

echo "[SETUP] Selesai. Pastikan file .env ada di root repo."
echo "[SETUP] Paket NPM: express cors @upstash/redis camoufox-js playwright dotenv"
echo "[SETUP] Proses PM2: gateway-otomatis + bot-github"
