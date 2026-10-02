#!/usr/bin/env bash
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export HEADLESS="${HEADLESS:-true}"
export DISPLAY="${DISPLAY:-:99}"
export CAMOUFOX_INSTALL_DIR="${CAMOUFOX_INSTALL_DIR:-/home/node/.cache/camoufox}"
if command -v stdbuf >/dev/null 2>&1; then
  exec stdbuf -oL -eL node bot_github.js
else
  exec node bot_github.js
fi
