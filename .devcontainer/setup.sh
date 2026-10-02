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
npx camoufox-js fetch
npx camoufox-js path || true
npx camoufox-js version || true

echo "[setup] 5/5 runtime folders..."
mkdir -p "$ROOT/hasil_media" "$ROOT/temp_uploads" "$ROOT/.devcontainer"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) setup-ok root=$ROOT" > "$ROOT/.devcontainer/.setup-complete"
echo "[setup] COMPLETE workspace=$ROOT"
