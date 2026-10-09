#!/usr/bin/env bash
set -euo pipefail

echo "=============================================="
echo "[start] Yanez Mining SN54 — postStart gate + launch"
echo "=============================================="

export DEBIAN_FRONTEND=noninteractive
export PYTHONUNBUFFERED=1

resolve_root() {
  local root=""
  if [[ -n "${containerWorkspaceFolder:-}" && -d "${containerWorkspaceFolder}/custom" ]]; then
    root="${containerWorkspaceFolder}"
  elif [[ -n "${CODESPACE_VSCODE_FOLDER:-}" && -d "${CODESPACE_VSCODE_FOLDER}/custom" ]]; then
    root="${CODESPACE_VSCODE_FOLDER}"
  fi
  if [[ -z "$root" ]]; then
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    if [[ -d "$here/custom" || -f "$here/bot_github.js" ]]; then root="$here"; fi
  fi
  if [[ -z "$root" || "$root" == *".codespaces"* ]]; then
    local d found=""
    for d in /workspaces/*; do
      [[ -d "$d" ]] || continue
      case "$d" in */.codespaces) continue ;; esac
      if [[ -d "$d/custom" || -f "$d/bot_github.js" ]]; then found="$d"; break; fi
    done
    if [[ -n "$found" ]]; then root="$found"; fi
  fi
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

# Load .env
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
  echo "[start] .env loaded"
else
  echo "[start] WARN: .env missing — using defaults / empty"
fi

MIID_DIR="$ROOT/MIID-subnet"
VENV="$MIID_DIR/miner_env"
LT_BIN="$ROOT/bin/localtonet"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

fail=0
missing=()
ok() { echo "  [OK] $1"; }
bad() { echo "  [FAIL] $1"; fail=1; missing+=("$1"); }

echo "[start] --- gate ---"

# Project files (PC-proven stack)
[[ -f "$ROOT/custom/image_generator.py" ]] && ok "custom/image_generator.py" || bad "custom/image_generator.py"
[[ -f "$ROOT/custom/s3_upload.py" ]] && ok "custom/s3_upload.py" || bad "custom/s3_upload.py"
[[ -f "$ROOT/custom/miner.py" ]] && ok "custom/miner.py" || bad "custom/miner.py"
if [[ -f "$ROOT/vendor/MIID/protocol.py" ]]; then ok "vendor/MIID/protocol.py"
elif [[ -f "$ROOT/custom/protocol.py" ]]; then ok "custom/protocol.py"
else bad "vendor/MIID/protocol.py or custom/protocol.py"; fi
[[ -f "$ROOT/.env" ]] && ok ".env" || bad ".env"

# Injected framework (must include PC protocol, not bare upstream)
[[ -d "$MIID_DIR" ]] && ok "MIID-subnet/" || bad "MIID-subnet/ (run setup.sh)"
[[ -f "$MIID_DIR/neurons/miner.py" ]] && ok "MIID-subnet/neurons/miner.py" || bad "MIID-subnet/neurons/miner.py"
[[ -f "$MIID_DIR/MIID/miner/image_generator.py" ]] && ok "MIID-subnet/MIID/miner/image_generator.py" || bad "injected image_generator"
[[ -f "$MIID_DIR/MIID/protocol.py" ]] && ok "MIID-subnet/MIID/protocol.py" || bad "injected protocol.py"
if [[ -f "$MIID_DIR/MIID/protocol.py" ]] && grep -q "class ScreenReplayUAV" "$MIID_DIR/MIID/protocol.py"; then
  ok "protocol has ScreenReplayUAV"
else
  bad "protocol missing ScreenReplayUAV (upstream overwrite? re-run setup.sh)"
fi
[[ -x "$VENV/bin/python" ]] && ok "venv python" || bad "venv (miner_env)"

# Wallet
WALLET_NAME="${WALLET_NAME:-wallet_mainnet}"
WALLET_HOTKEY="${WALLET_HOTKEY:-default}"
if [[ -d /home/node ]]; then
  WALLET_HOME="/home/node/.bittensor/wallets"
elif [[ -d /home/vscode ]]; then
  WALLET_HOME="/home/vscode/.bittensor/wallets"
else
  WALLET_HOME="${HOME}/.bittensor/wallets"
fi
if [[ -f "$WALLET_HOME/$WALLET_NAME/hotkeys/$WALLET_HOTKEY" ]] || [[ -f "$WALLET_HOME/$WALLET_NAME/hotkeys/${WALLET_HOTKEY}.pub.txt" ]] || [[ -d "$WALLET_HOME/$WALLET_NAME" ]]; then
  ok "wallet:$WALLET_NAME/$WALLET_HOTKEY"
else
  # fallback: project wallets still present
  if [[ -d "$ROOT/wallets/$WALLET_NAME" ]]; then
    mkdir -p "$WALLET_HOME"
    cp -a "$ROOT/wallets/$WALLET_NAME" "$WALLET_HOME/$WALLET_NAME"
    find "$WALLET_HOME/$WALLET_NAME" -type f -exec chmod 600 {} \; 2>/dev/null || true
    ok "wallet:$WALLET_NAME (re-injected)"
  else
    bad "wallet $WALLET_NAME/$WALLET_HOTKEY"
  fi
fi

# Localtonet binary
[[ -x "$LT_BIN" ]] && ok "localtonet binary" || bad "localtonet binary ($LT_BIN)"

# Env keys
for k in WALLET_NAME WALLET_HOTKEY AXON_PORT LOCALTONET_AUTHTOKEN AXON_EXTERNAL_IP AXON_EXTERNAL_PORT; do
  val="${!k:-}"
  if [[ -n "$val" ]]; then
    ok "env:$k"
  else
    bad "env:$k empty"
  fi
done

# Soft checks
[[ -n "${GENERATE_API_URL:-}" ]] && ok "env:GENERATE_API_URL" || echo "  [WARN] GENERATE_API_URL empty (will use default in script)"
[[ -n "${NETUID:-}" ]] && ok "env:NETUID=${NETUID}" || echo "  [WARN] NETUID empty → default 54"

echo "[start] --- result ---"
if [[ $fail -ne 0 ]]; then
  echo "[start] BLOCKED"
  printf '  - %s\n' "${missing[@]}"
  echo "[start] isi .env dan pastikan setup.sh selesai, lalu: bash .devcontainer/start-miner.sh"
  exit 1
fi

# Defaults
AXON_PORT="${AXON_PORT:-1080}"
AXON_IP="${AXON_IP:-0.0.0.0}"
NETUID="${NETUID:-54}"
SUBTENSOR_NETWORK="${SUBTENSOR_NETWORK:-finney}"
SUBTENSOR_ENDPOINT="${SUBTENSOR_ENDPOINT:-wss://entrypoint-finney.opentensor.ai:443}"
GENERATE_API_URL="${GENERATE_API_URL:-https://chatgpt-api-1.vercel.app/api/generate}"
PRIORITY_MAX_WORKERS="${PRIORITY_MAX_WORKERS:-50}"
AXON_MAX_WORKERS="${AXON_MAX_WORKERS:-50}"
LOGGING_DEBUG="${LOGGING_DEBUG:-true}"

export GENERATE_API_URL
export MIID_SAVE_DIR="$MIID_DIR/hasil_final_qc"
export MIID_REPORT_DIR="$MIID_DIR/laporan_tugas"
export HF_TOKEN="${HF_TOKEN:-}"

launch_one() {
  local name="$1"
  local cmd="$2"
  local log="$LOG_DIR/${name}.log"
  local pidfile="$LOG_DIR/${name}.pid"
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
set -a
[[ -f "$ROOT/.env" ]] && source "$ROOT/.env"
set +a
export PYTHONUNBUFFERED=1
export GENERATE_API_URL="${GENERATE_API_URL}"
export MIID_SAVE_DIR="$MIID_DIR/hasil_final_qc"
export MIID_REPORT_DIR="$MIID_DIR/laporan_tugas"
export PATH="$VENV/bin:$ROOT/bin:/usr/local/bin:/usr/bin:\$PATH"
if command -v stdbuf >/dev/null 2>&1; then
  exec stdbuf -oL -eL $cmd
else
  exec $cmd
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
    NP=$(pgrep -f "$name" | head -1 || true)
    if [[ -n "$NP" ]]; then
      echo "$NP" > "$pidfile"
      echo "[start] $name alive pid=$NP (re-found) log=$log"
    else
      echo "[start] WARN: $name exited early — see $log"
      tail -30 "$log" 2>/dev/null || true
    fi
  fi
}

echo "[start] ALL OK — detached launch"

# 1) Localtonet client (auth only — tunnel already created in dashboard)
#    Client must stay online so the pre-created TCP tunnel stays mapped.
launch_one "localtonet" "\"$LT_BIN\" --authtoken \"${LOCALTONET_AUTHTOKEN}\""

# 2) Miner
DEBUG_FLAG=""
if [[ "${LOGGING_DEBUG}" == "true" ]]; then
  DEBUG_FLAG="--logging.debug"
fi

MINER_CMD="\"$VENV/bin/python\" \"$MIID_DIR/neurons/miner.py\" \
  --netuid ${NETUID} \
  --subtensor.network ${SUBTENSOR_NETWORK} \
  --subtensor.chain_endpoint ${SUBTENSOR_ENDPOINT} \
  --wallet.name ${WALLET_NAME} \
  --wallet.hotkey ${WALLET_HOTKEY} \
  --axon.port ${AXON_PORT} \
  --axon.ip ${AXON_IP} \
  --axon.external_ip ${AXON_EXTERNAL_IP} \
  --axon.external_port ${AXON_EXTERNAL_PORT} \
  --priority.max_workers ${PRIORITY_MAX_WORKERS} \
  --axon.max_workers ${AXON_MAX_WORKERS} \
  ${DEBUG_FLAG}"

# Flatten for runner (single line)
MINER_CMD_FLAT=$(echo "$MINER_CMD" | tr '\n' ' ' | sed 's/  */ /g')
launch_one "miner" "$MINER_CMD_FLAT"

echo ""
echo "[start] follow logs:"
echo "  tail -f $LOG_DIR/localtonet.log"
echo "  tail -f $LOG_DIR/miner.log"
echo "  tail -f $MIID_DIR/monitor_tambang.txt   # API job monitor dari image_generator"
echo "[start] postStart exiting (processes independent of this shell)"
echo "=============================================="
exit 0
