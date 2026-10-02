#!/usr/bin/env bash
set -euo pipefail

echo "=============================================="
echo "[start] postStart — gate then bot + gateway (detached)"
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
echo "[start] Workspace: $ROOT"

if command -v git &>/dev/null; then
  git config --global --add safe.directory "$ROOT" 2>/dev/null || true
  git config --global --add safe.directory "*" 2>/dev/null || true
fi

fail=0
missing=()
ok() { echo "  [OK] $1"; }
bad() { echo "  [FAIL] $1"; fail=1; missing+=("$1"); }

echo "[start] --- gate ---"
[[ -f bot_github.js ]] && ok "bot_github.js" || bad "bot_github.js missing in $ROOT"
[[ -f gateway.js ]] && ok "gateway.js" || bad "gateway.js missing in $ROOT"
[[ -f qstash_deadman.js ]] && ok "qstash_deadman.js" || bad "qstash_deadman.js missing"
[[ -f platforms/chatgpt.js ]] && ok "platforms/chatgpt.js" || bad "platforms/chatgpt.js missing"
[[ -f .env ]] && ok ".env" || bad ".env missing in $ROOT"
command -v node &>/dev/null && ok "node $(node -v)" || bad "node"

for pkg in camoufox-js @upstash/redis dotenv express cors; do
  if npm list "$pkg" --depth=0 &>/dev/null; then
    ok "npm:$pkg"
  else
    bad "npm:$pkg not in $ROOT"
  fi
done

if ldconfig -p 2>/dev/null | grep -q libgtk-3.so || [[ -e /usr/lib/x86_64-linux-gnu/libgtk-3.so.0 ]]; then
  ok "libgtk-3.so"
else
  bad "libgtk-3.so missing"
fi

CAMOU=$(npx camoufox-js path 2>/dev/null || true)
[[ -n "$CAMOU" ]] && ok "camoufox:$CAMOU" || {
  npx camoufox-js fetch || true
  CAMOU=$(npx camoufox-js path 2>/dev/null || true)
  [[ -n "$CAMOU" ]] && ok "camoufox:$CAMOU" || bad "camoufox binary"
}

if [[ -f .env ]]; then
  for k in UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN BOT_PROXY_HOST BOT_PROXY_PORT; do
    grep -qE "^[[:space:]]*$k=" .env 2>/dev/null && ok "env:$k" || bad "env:$k"
  done
  # Deadman / estafet (gateway) — warn only, jangan blok start bot
  for k in QSTASH_TOKEN WATCHDOG_URL CODESPACE_TARGET_REPO SHIFTS_PER_PAT; do
    if grep -qE "^[[:space:]]*$k=" .env 2>/dev/null; then
      ok "env:$k"
    else
      echo "  [WARN] env:$k missing (deadman/estafet)"
    fi
  done
fi

echo "[start] --- result ---"
if [[ $fail -ne 0 ]]; then
  echo "[start] BLOCKED"
  printf '  - %s\n' "${missing[@]}"
  exit 1
fi

export HEADLESS="${HEADLESS:-true}"
export DISPLAY="${DISPLAY:-:99}"
export CAMOUFOX_INSTALL_DIR="${CAMOUFOX_INSTALL_DIR:-/home/node/.cache/camoufox}"

# Xvfb for headless Camoufox (gateway also spawns its own; this is backup)
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  if command -v Xvfb >/dev/null 2>&1; then
    Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
    sleep 1
    echo "[start] Xvfb :99 started"
  fi
fi

launch_one() {
  local name="$1"
  local script="$2"
  local log="$ROOT/${name}.log"
  local pidfile="$ROOT/${name}.pid"
  local runner="$ROOT/.devcontainer/run-${name}.sh"

  if [[ -f "$pidfile" ]]; then
    oldpid=$(cat "$pidfile" 2>/dev/null || true)
    if [[ -n "$oldpid" ]] && kill -0 "$oldpid" 2>/dev/null; then
      echo "[start] stopping previous $name pid=$oldpid"
      kill "$oldpid" 2>/dev/null || true
      sleep 2
      kill -9 "$oldpid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi

  cat > "$runner" << RUNEOF
#!/usr/bin/env bash
cd "$ROOT"
export HEADLESS="${HEADLESS:-true}"
export DISPLAY="${DISPLAY:-:99}"
export CAMOUFOX_INSTALL_DIR="${CAMOUFOX_INSTALL_DIR:-/home/node/.cache/camoufox}"
export PATH="/usr/local/bin:/usr/bin:\$HOME/.npm-global/bin:\$PATH"
if command -v stdbuf >/dev/null 2>&1; then
  exec stdbuf -oL -eL node ${script}
else
  exec node ${script}
fi
RUNEOF
  chmod +x "$runner"

  if command -v setsid >/dev/null 2>&1; then
    setsid "$runner" >> "$log" 2>&1 < /dev/null &
  else
    nohup "$runner" >> "$log" 2>&1 < /dev/null &
  fi
  local BPID=$!
  echo "$BPID" > "$pidfile"
  sleep 2
  if kill -0 "$BPID" 2>/dev/null; then
    echo "[start] $name alive pid=$BPID log=$log"
  else
    NP=$(pgrep -f "node ${script}" | head -1 || true)
    if [[ -n "$NP" ]]; then
      echo "$NP" > "$pidfile"
      echo "[start] $name alive pid=$NP (re-found) log=$log"
    else
      echo "[start] WARN: $name exited early — see $log"
      tail -20 "$log" 2>/dev/null || true
    fi
  fi
}

echo "[start] ALL OK — detached launch"
launch_one "bot_github" "bot_github.js"
launch_one "gateway" "gateway.js"

echo "[start] follow: tail -f $ROOT/bot_github.log $ROOT/gateway.log"
echo "[start] postStart exiting (processes independent of this shell)"
echo "=============================================="
exit 0
