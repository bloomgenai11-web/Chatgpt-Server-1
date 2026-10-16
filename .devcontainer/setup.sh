#!/usr/bin/env bash
set -euo pipefail

echo "=============================================="
echo "[setup] Codespace postCreate — install deps (bot + gateway)"
echo "=============================================="

export DEBIAN_FRONTEND=noninteractive

# Resolve workspace root for any repo name (not only "git")
resolve_root() {
  local root=""
  # 1) VS Code / Codespace injected folder
  if [[ -n "${containerWorkspaceFolder:-}" && -f "${containerWorkspaceFolder}/bot_github.js" ]]; then
    root="${containerWorkspaceFolder}"
  elif [[ -n "${CODESPACE_VSCODE_FOLDER:-}" && -f "${CODESPACE_VSCODE_FOLDER}/bot_github.js" ]]; then
    root="${CODESPACE_VSCODE_FOLDER}"
  fi
  # 2) script lives in .devcontainer/ → parent is repo root
  if [[ -z "$root" ]]; then
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    if [[ -f "$here/bot_github.js" ]]; then root="$here"; fi
  fi
  # 3) scan /workspaces/* (skip .codespaces)
  if [[ -z "$root" || "$root" == *".codespaces"* ]]; then
    local d found=""
    for d in /workspaces/*; do
      [[ -d "$d" ]] || continue
      case "$d" in */.codespaces) continue ;; esac
      if [[ -f "$d/bot_github.js" ]]; then found="$d"; break; fi
    done
    if [[ -n "$found" ]]; then root="$found"; fi
  fi
  # 4) fallback pwd
  if [[ -z "$root" ]]; then root="$(pwd)"; fi
  printf '%s' "$root"
}

ROOT="$(resolve_root)"
cd "$ROOT"
echo "[setup] Workspace: $ROOT (pwd=$(pwd))"
ls -la "$ROOT" | head -20 || true

if command -v git &>/dev/null; then
  git config --global --add safe.directory "$ROOT" 2>/dev/null || true
  git config --global --add safe.directory "*" 2>/dev/null || true
fi

echo "[setup] 1/5 Installing system libraries (Bookworm classic first)..."
sudo apt-get update -qq

install_pkg() {
  local pkg="$1"
  if apt-cache show "$pkg" &>/dev/null; then
    echo "  -> $pkg"
    sudo apt-get install -y --no-install-recommends "$pkg" >/dev/null && return 0
  fi
  echo "  !! skip: $pkg"
  return 1
}

# CRITICAL: Bookworm uses libgtk-3-0 NOT t64 — try classic FIRST
install_pkg libgtk-3-0 || install_pkg libgtk-3-0t64 || true
install_pkg libasound2 || install_pkg libasound2t64 || true
install_pkg libxt6 || install_pkg libxt6t64 || true
install_pkg libatk1.0-0 || install_pkg libatk1.0-0t64 || true
install_pkg libatk-bridge2.0-0 || install_pkg libatk-bridge2.0-0t64 || true
install_pkg libcups2 || install_pkg libcups2t64 || true

for pkg in libx11-xcb1 libdbus-glib-1-2 libnss3 libnspr4 libgbm1 libdrm2 \
  libxkbcommon0 libpango-1.0-0 libcairo2 libxcomposite1 libxdamage1 \
  libxrandr2 libxrender1 fonts-liberation ca-certificates curl \
  xvfb libgl1 libosmesa6 wget
do
  install_pkg "$pkg" || true
done

# Force gtk if still missing
if ! ldconfig -p 2>/dev/null | grep -q libgtk-3.so; then
  echo "[setup] force libgtk-3-0..."
  sudo apt-get install -y --no-install-recommends libgtk-3-0 || true
fi

sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/* 2>/dev/null || true
echo "[setup] System libraries done."

echo "[setup] 2/5 Verifying libgtk-3..."
ldconfig -p 2>/dev/null | grep libgtk-3 || ls -la /usr/lib/x86_64-linux-gnu/libgtk-3* 2>/dev/null || echo "  WARN: still no libgtk"

echo "[setup] 3/5 npm in $ROOT ..."
# bot: camoufox-js redis dotenv | gateway: + express cors
if [[ -f package.json ]]; then
  npm install --prefer-offline --no-audit --no-fund
else
  npm install camoufox-js @upstash/redis dotenv express cors
fi
npm list camoufox-js @upstash/redis dotenv express cors --depth=0 2>/dev/null \
  || npm install camoufox-js @upstash/redis dotenv express cors
echo "[setup] npm done."

echo "[setup] 4/5 Camoufox fetch..."
mkdir -p "${CAMOUFOX_INSTALL_DIR:-/home/node/.cache/camoufox}"
# Link resmi (contoh beta.33):
# https://github.com/daijro/camoufox/releases/download/v156.0.1-beta.33/camoufox-156.0.1-beta.33-lin.x86_64.zip
CAMOUFOX_PIN="${CAMOUFOX_VERSION:-v156.0.1-beta.33}"
VER_NUM="${CAMOUFOX_PIN#v}"
DEST="${CAMOUFOX_INSTALL_DIR:-/home/node/.cache/camoufox}"
ZIP_URL="https://github.com/daijro/camoufox/releases/download/${CAMOUFOX_PIN}/camoufox-${VER_NUM}-lin.x86_64.zip"
echo "[setup] pin=$CAMOUFOX_PIN"
echo "[setup] url=$ZIP_URL"
PIN_OK=0
TMPZ="/tmp/camoufox-pin.zip"
if curl -fL --retry 3 -o "$TMPZ" "$ZIP_URL"; then
  mkdir -p "$DEST"
  if command -v unzip >/dev/null; then
    unzip -qo "$TMPZ" -d "$DEST" && PIN_OK=1
  else
    python3 -c "import zipfile; zipfile.ZipFile('$TMPZ').extractall('$DEST')" && PIN_OK=1
  fi
  rm -f "$TMPZ"
fi
if [[ "$PIN_OK" = "1" ]]; then
  echo "[setup] pin extracted -> $DEST"
  # version.json: CLI camoufox-js menggunakannya untuk deteksi install
  printf '%s\n' "{\"version\":\"${VER_NUM}\",\"release\":\"${CAMOUFOX_PIN}\"}" > "$DEST/version.json"
  echo "[setup] wrote version.json"
  FOUND=$(find "$DEST" -maxdepth 3 -type f \( -name 'camoufox-bin' -o -name 'camoufox' \) 2>/dev/null | head -1)
  echo "[setup] binary: ${FOUND:-NONE}"
  if [[ -n "$FOUND" ]]; then
    SUB=$(dirname "$FOUND")
    if [[ "$SUB" != "$DEST" ]]; then
      echo "[setup] normalize layout $SUB -> $DEST"
      shopt -s dotglob nullglob
      cp -a "$SUB"/* "$DEST"/ 2>/dev/null || true
      shopt -u dotglob nullglob
      printf '%s\n' "{\"version\":\"${VER_NUM}\",\"release\":\"${CAMOUFOX_PIN}\"}" > "$DEST/version.json"
    fi
    chmod +x "$DEST/camoufox-bin" "$DEST/camoufox" 2>/dev/null || true
  fi
  echo "[setup] pin OK — skip npx fetch"
else
  echo "[setup] pin gagal -> npx camoufox-js fetch"
  CI=1 npx --yes camoufox-js fetch || npx camoufox-js fetch || true
fi
npx camoufox-js path || true
npx camoufox-js version || true

# Patch properties.json saja (install-time) — TIDAK load camoufox_safe di runtime bot/gateway
# Mengatasi: Unknown property navigator.product in config
node << 'NODEPATCH' || true
const fs = require('fs');
const path = require('path');
const EXTRA = [
  { property: 'navigator.product', type: 'str' },
  { property: 'navigator.productSub', type: 'str' },
  { property: 'navigator.buildID', type: 'str' },
  { property: 'navigator.globalPrivacyControl', type: 'bool' },
  { property: 'navigator.cookieEnabled', type: 'bool' },
  { property: 'navigator.onLine', type: 'bool' },
  { property: 'navigator.appCodeName', type: 'str' },
  { property: 'navigator.appName', type: 'str' },
  { property: 'navigator.appVersion', type: 'str' },
  { property: 'navigator.vendor', type: 'str' },
  { property: 'navigator.vendorSub', type: 'str' },
  { property: 'navigator.doNotTrack', type: 'str' },
  { property: 'navigator.oscpu', type: 'str' },
  { property: 'navigator.hardwareConcurrency', type: 'uint' },
  { property: 'navigator.maxTouchPoints', type: 'uint' },
  { property: 'navigator.platform', type: 'str' },
  { property: 'navigator.userAgent', type: 'str' },
  { property: 'navigator.language', type: 'str' },
  { property: 'navigator.languages', type: 'array' },
];
function walk(d, depth, acc) {
  if (!d || depth > 6) return;
  let e;
  try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) {
    const p = path.join(d, x.name);
    if (x.isDirectory() && x.name !== 'node_modules') walk(p, depth + 1, acc);
    else if (x.isFile()) acc.push(p);
  }
}
const roots = [
  process.env.CAMOUFOX_INSTALL_DIR,
  path.join(process.env.HOME || '', '.cache/camoufox'),
  '/home/node/.cache/camoufox',
].filter(Boolean);
try { roots.push(path.dirname(require.resolve('camoufox-js/package.json'))); } catch {}
const files = [];
for (const r of roots) walk(r, 0, files);
let n = 0;
for (const f of files) {
  if (path.basename(f) !== 'properties.json') continue;
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(data)) continue;
    const have = new Set(data.map((x) => x && x.property).filter(Boolean));
    let ch = false;
    for (const row of EXTRA) {
      if (!have.has(row.property)) { data.push(row); have.add(row.property); ch = true; }
    }
    if (ch) { fs.writeFileSync(f, JSON.stringify(data, null, 2)); n++; }
  } catch {}
}
console.log('[setup] properties.json patched files=' + n);
NODEPATCH

# Soft-patch: Unknown property → skip (bukan throw) di camoufox-js validateConfig
node << 'NODEVAL' || true
const fs = require('fs');
const path = require('path');
function walk(d, depth, acc) {
  if (!d || depth > 8) return;
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) {
    const p = path.join(d, x.name);
    if (x.isDirectory()) {
      if (x.name === '.git') continue;
      walk(p, depth + 1, acc);
    } else if (x.isFile() && /\.(js|cjs|mjs)$/.test(x.name)) acc.push(p);
  }
}
const roots = [];
try { roots.push(path.dirname(require.resolve('camoufox-js/package.json'))); } catch {}
roots.push(path.join(process.cwd(), 'node_modules', 'camoufox-js'));
const files = [];
for (const r of roots) walk(r, 0, files);
let n = 0;
for (const f of files) {
  let src;
  try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (!src.includes('Unknown property') || !/validateConfig/.test(src)) continue;
  let next = src.replace(
    /if\s*\(\s*!expectedType\s*\)\s*\{\s*throw new UnknownProperty\([^)]*\);\s*\}/g,
    'if (!expectedType) { continue; }'
  );
  if (next === src) {
    next = src.replace(
      /throw new UnknownProperty\(`Unknown property \$\{key\} in config`\)/g,
      'continue'
    );
  }
  if (next !== src) {
    fs.writeFileSync(f, next);
    n++;
    console.log('[setup] validateConfig patched', f);
  }
}
console.log('[setup] validateConfig patched files=' + n);
NODEVAL

echo "[setup] 5/5 runtime folders..."
mkdir -p "$ROOT/hasil_media" "$ROOT/temp_uploads" "$ROOT/.devcontainer"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) setup-ok root=$ROOT" > "$ROOT/.devcontainer/.setup-complete"
echo "[setup] COMPLETE workspace=$ROOT"
