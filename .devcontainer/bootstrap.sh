#!/usr/bin/env bash
# Fallback one-shot if postCreate path fails due to trust/path issues
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# find repo root containing bot_github.js
ROOT=""
for d in /workspaces/* /workspaces /home/node /home/codespace; do
  if [[ -f "$d/bot_github.js" ]]; then ROOT="$d"; break; fi
  if [[ -f "$d/.devcontainer/../bot_github.js" ]]; then ROOT="$(cd "$d/.." && pwd)"; break; fi
done
if [[ -z "$ROOT" ]]; then
  ROOT="$(pwd)"
fi
cd "$ROOT"
echo "[bootstrap] root=$ROOT"

git config --global --add safe.directory "*" 2>/dev/null || true
git config --global --add safe.directory "$ROOT" 2>/dev/null || true

bash "$ROOT/.devcontainer/setup.sh"
bash "$ROOT/.devcontainer/start-bot.sh"
