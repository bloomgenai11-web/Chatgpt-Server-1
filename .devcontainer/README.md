# Dev Container — github-bot

## Paket yang diinstal (syarat tetap, tidak diubah)

### System (apt) — Camoufox/Firefox
| Paket | Catatan |
|-------|---------|
| libgtk-3-0t64 **atau** libgtk-3-0 | Wajib (XPCOM/GTK) |
| libasound2t64 **atau** libasound2 | Audio |
| libxt6t64 **atau** libxt6 | X11 |
| libatk1.0-0t64 **atau** libatk1.0-0 | Accessibility |
| libatk-bridge2.0-0t64 **atau** libatk-bridge2.0-0 | ATK bridge |
| libcups2t64 **atau** libcups2 | Printing stack |
| libx11-xcb1 | XCB |
| libdbus-glib-1-2 | D-Bus |
| libnss3, libnspr4 | NSS |
| libgbm1, libdrm2 | Graphics |
| libxkbcommon0 | Keyboard |
| libpango-1.0-0, libcairo2 | Text/render |
| libxcomposite1, libxdamage1, libxrandr2, libxrender1 | X extensions |
| fonts-liberation | Fonts |
| ca-certificates, curl | TLS / download |

### npm (wajib)
| Package | Fungsi |
|---------|--------|
| camoufox-js | Browser anti-detect |
| @upstash/redis | Queue + PAT stock |
| dotenv | Baca `.env` |

### Binary
- Camoufox browser (`npx camoufox-js fetch`) → path dari `npx camoufox-js path`

## Gate start-bot

`start-bot.sh` **hanya** menjalankan `node bot_github.js` jika deteksi lengkap:

1. `bot_github.js` + `.env` ada  
2. `node` ada  
3. npm: `camoufox-js`, `@upstash/redis`, `dotenv` terpasang  
4. `libgtk-3.so` terdeteksi  
5. path binary Camoufox valid (auto-fetch sekali jika kosong)  
6. key `.env` minimal: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `BOT_PROXY_HOST`, `BOT_PROXY_PORT`  

Jika ada yang gagal → bot **tidak** dijalankan; pesan `[FAIL]` + daftar missing.

## Alur Codespace

1. **postCreate** → `setup.sh` (apt + npm + fetch + tulis `.devcontainer/.setup-complete`)  
2. **postStart** → `start-bot.sh` (gate lengkap → bot)

## Folder not trusted / dubious ownership

Kedua script set:

```bash
git config --global --add safe.directory "$ROOT"
git config --global --add safe.directory "*"
```

`devcontainer.json` juga mematikan workspace trust ketat di VS Code settings.

## Manual

```bash
bash .devcontainer/setup.sh      # install ulang
bash .devcontainer/start-bot.sh  # gate + bot
node bot_github.js               # langsung (tanpa gate)
```
