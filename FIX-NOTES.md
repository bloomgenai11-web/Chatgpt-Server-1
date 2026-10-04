# WORK EKOSISTEM-FIX (latest)

## Camoufox pin
- Default: `CAMOUFOX_VERSION=v156.0.1-beta.33`
- URL: `https://github.com/daijro/camoufox/releases/download/v156.0.1-beta.33/camoufox-156.0.1-beta.33-lin.x86_64.zip`
- Setelah extract: tulis `version.json`, normalisasi binary ke root cache
- Jika pin OK: **skip** `npx camoufox-js fetch` (hindari overwrite beta.34)

## Runtime
- `camoufox_launch.js` — hanya Camoufox + retry `config:{}` (tanpa playwright / camoufox_safe)

## Gate
- Wajib `camoufox_launch.js` (bukan camoufox_safe.js)
