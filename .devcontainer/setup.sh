#!/usr/bin/env bash
set -euo pipefail

echo "=============================================="
echo "[setup] UNIFIED — Ekosistem bot/gateway + Yanez mining"
echo "=============================================="

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo ">>>>>>>>>> PHASE 1/2: EKOSISTEM (node + camoufox) <<<<<<<<<<"
bash "$HERE/setup-ekos.sh"

echo ""
echo ">>>>>>>>>> PHASE 2/2: YANEZ MINING (python + localtonet) <<<<<<<<<<"
bash "$HERE/setup-yanez.sh"

echo ""
echo "[setup] UNIFIED COMPLETE"
echo "=============================================="
