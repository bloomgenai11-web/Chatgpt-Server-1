#!/usr/bin/env bash
set -euo pipefail

echo "=============================================="
echo "[setup] Yanez Mining SN54 — postCreate"
echo "=============================================="

export DEBIAN_FRONTEND=noninteractive

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
echo "[setup] Workspace: $ROOT"
ls -la "$ROOT" | head -20 || true

if command -v git &>/dev/null; then
  git config --global --add safe.directory "$ROOT" 2>/dev/null || true
  git config --global --add safe.directory "*" 2>/dev/null || true
fi

# 1/6 system packages
echo "[setup] 1/6 system packages..."
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
for pkg in python3 python3-pip python3-venv python3-dev build-essential \
  git curl wget unzip ca-certificates libgl1 libglib2.0-0 libsm6 libxext6 \
  libxrender1 libgomp1 fonts-liberation; do
  install_pkg "$pkg" || true
done
sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/* 2>/dev/null || true
echo "[setup] system packages done."

# 2/6 clone skeleton
echo "[setup] 2/6 clone MIID-subnet skeleton..."
MIID_DIR="$ROOT/MIID-subnet"
if [[ -d "$MIID_DIR/.git" ]]; then
  echo "[setup] MIID-subnet already present — pull skeleton"
  (cd "$MIID_DIR" && git pull --ff-only || true)
else
  rm -rf "$MIID_DIR"
  git clone --depth 1 https://github.com/yanez-compliance/MIID-subnet.git "$MIID_DIR"
fi
echo "[setup] MIID-subnet at $MIID_DIR"

# 3/6 FULL PC vendor inject
echo "[setup] 3/6 inject FULL PC-proven MIID package..."
mkdir -p "$MIID_DIR/MIID" "$MIID_DIR/neurons"

VENDOR_MIID=""
if [[ -d "$ROOT/vendor/MIID" && -f "$ROOT/vendor/MIID/protocol.py" ]]; then
  VENDOR_MIID="$ROOT/vendor/MIID"
elif [[ -d "$ROOT/custom/MIID" && -f "$ROOT/custom/MIID/protocol.py" ]]; then
  VENDOR_MIID="$ROOT/custom/MIID"
fi

if [[ -n "$VENDOR_MIID" ]]; then
  rm -rf "$MIID_DIR/MIID"
  mkdir -p "$MIID_DIR/MIID"
  cp -a "$VENDOR_MIID"/. "$MIID_DIR/MIID/"
  echo "  [OK] full MIID/ package from vendor (protocol+validator+base+miner modules)"
else
  echo "  [WARN] vendor/MIID missing — falling back to per-file custom inject"
  mkdir -p "$MIID_DIR/MIID/miner" "$MIID_DIR/MIID/base"
  [[ -f "$ROOT/custom/protocol.py" ]] && cp -f "$ROOT/custom/protocol.py" "$MIID_DIR/MIID/protocol.py" && echo "  [OK] protocol.py"
  [[ -f "$ROOT/custom/base_miner.py" ]] && cp -f "$ROOT/custom/base_miner.py" "$MIID_DIR/MIID/base/miner.py" && echo "  [OK] base/miner.py"
  [[ -f "$ROOT/custom/image_generator.py" ]] && cp -f "$ROOT/custom/image_generator.py" "$MIID_DIR/MIID/miner/image_generator.py" && echo "  [OK] image_generator.py"
  [[ -f "$ROOT/custom/s3_upload.py" ]] && cp -f "$ROOT/custom/s3_upload.py" "$MIID_DIR/MIID/miner/s3_upload.py" && echo "  [OK] s3_upload.py"
  [[ -f "$ROOT/custom/drand_encrypt.py" ]] && cp -f "$ROOT/custom/drand_encrypt.py" "$MIID_DIR/MIID/miner/drand_encrypt.py" && echo "  [OK] drand_encrypt.py"
fi

if [[ -f "$ROOT/vendor/neurons/miner.py" ]]; then
  cp -f "$ROOT/vendor/neurons/miner.py" "$MIID_DIR/neurons/miner.py"
  echo "  [OK] neurons/miner.py (vendor)"
elif [[ -f "$ROOT/custom/miner.py" ]]; then
  cp -f "$ROOT/custom/miner.py" "$MIID_DIR/neurons/miner.py"
  echo "  [OK] neurons/miner.py (custom)"
else
  echo "  [FAIL] miner.py missing in vendor/ and custom/"
fi

export ROOT
python3 - << 'PY' || true
import os, re
root = os.environ.get("ROOT") or os.getcwd()
path = os.path.join(root, "MIID-subnet", "MIID", "miner", "image_generator.py")
if not os.path.isfile(path):
    raise SystemExit(0)
with open(path, "r", encoding="utf-8") as f:
    src = f.read()
src2 = src
if "import os" not in src2.split("\n")[0:30]:
    src2 = "import os\n" + src2
if 'os.environ.get("GENERATE_API_URL"' not in src2 and "os.environ.get('GENERATE_API_URL'" not in src2:
    src2 = re.sub(
        r'^API_URL\s*=\s*["\'][^"\']+["\']',
        'API_URL = os.environ.get("GENERATE_API_URL", "https://chatgpt-api-1.vercel.app/api/generate")',
        src2,
        count=1,
        flags=re.M,
    )
if src2 != src:
    with open(path, "w", encoding="utf-8") as f:
        f.write(src2)
    print("[setup] GENERATE_API_URL env override added")
else:
    print("[setup] image_generator API_URL left as-is")
PY

if grep -q "class ScreenReplayUAV" "$MIID_DIR/MIID/protocol.py" 2>/dev/null; then
  echo "  [OK] protocol has ScreenReplayUAV (PC stack)"
else
  echo "  [FAIL] protocol missing ScreenReplayUAV — inject incomplete"
fi
if grep -q "VoiceRequest" "$MIID_DIR/MIID/validator/forward.py" 2>/dev/null; then
  echo "  [FAIL] validator/forward still references VoiceRequest — wrong tree"
else
  echo "  [OK] validator/forward matches PC protocol (no VoiceRequest)"
fi

# node image uses /home/node; python image uses /home/vscode
if [[ -d /home/node ]]; then
  WALLET_HOME="/home/node/.bittensor/wallets"
elif [[ -d /home/vscode ]]; then
  WALLET_HOME="/home/vscode/.bittensor/wallets"
else
  WALLET_HOME="${HOME}/.bittensor/wallets"
fi
mkdir -p "$WALLET_HOME"
if [[ -d "$ROOT/wallets" ]]; then
  for w in "$ROOT/wallets"/*; do
    [[ -d "$w" ]] || continue
    name="$(basename "$w")"
    rm -rf "$WALLET_HOME/$name"
    cp -a "$w" "$WALLET_HOME/$name"
    find "$WALLET_HOME/$name" -type f -exec chmod 600 {} \; 2>/dev/null || true
    echo "  [OK] wallet injected: $name → $WALLET_HOME/$name"
  done
else
  echo "  [WARN] no wallets/ folder in project"
fi

mkdir -p "$MIID_DIR/hasil_final_qc" "$MIID_DIR/laporan_tugas" "$ROOT/logs"
echo "[setup] inject done."

# 4/6 venv
echo "[setup] 4/6 python venv + deps..."
VENV="$MIID_DIR/miner_env"
if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --upgrade pip "setuptools>=68,<82" wheel -q
if [[ -f "$MIID_DIR/requirements.txt" ]]; then
  pip install -r "$MIID_DIR/requirements.txt" -q || pip install -r "$MIID_DIR/requirements.txt"
fi
pip install -e "$MIID_DIR" -q || pip install -e "$MIID_DIR"
pip install requests pillow opencv-python-headless numpy -q || true
echo "[setup] python deps done. ($(python -V))"

# 5/6 localtonet
echo "[setup] 5/6 localtonet..."
LT_DIR="$ROOT/bin"
mkdir -p "$LT_DIR"
LT_BIN="$LT_DIR/localtonet"
if [[ ! -x "$LT_BIN" ]]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) ZIP_URL="https://localtonet.com/download/localtonet-linux-x64.zip" ;;
    aarch64|arm64) ZIP_URL="https://localtonet.com/download/localtonet-linux-arm64.zip" ;;
    *) ZIP_URL="https://localtonet.com/download/localtonet-linux-x64.zip" ;;
  esac
  TMPZ="/tmp/localtonet.zip"
  if curl -fL --retry 3 -o "$TMPZ" "$ZIP_URL"; then
    unzip -qo "$TMPZ" -d /tmp/localtonet-extract
    FOUND="$(find /tmp/localtonet-extract -type f -name 'localtonet' | head -1)"
    if [[ -n "$FOUND" ]]; then
      cp -f "$FOUND" "$LT_BIN"
      chmod 755 "$LT_BIN"
      echo "[setup] localtonet installed → $LT_BIN"
    else
      echo "[setup] WARN: localtonet binary not found in zip"
    fi
    rm -rf /tmp/localtonet-extract "$TMPZ"
  else
    echo "[setup] WARN: localtonet download failed"
  fi
else
  echo "[setup] localtonet already present → $LT_BIN"
fi
"$LT_BIN" --version 2>/dev/null || true

# 6/6 marker
echo "[setup] 6/6 marker..."
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) setup-ok root=$ROOT full-vendor-inject" > "$ROOT/.devcontainer/.setup-complete"
echo "[setup] COMPLETE workspace=$ROOT"
echo "=============================================="
