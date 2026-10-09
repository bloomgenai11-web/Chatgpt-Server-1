#!/usr/bin/env bash
set -euo pipefail

echo "=============================================="
echo "[start] UNIFIED postStart — ekosistem + yanez"
echo "=============================================="

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Both stacks load the same .env at ROOT; each has its own gate.
# Failures in one stack must not block the other if possible,
# but we still surface exit codes.

eko_rc=0
yan_rc=0

echo ""
echo ">>>>>>>>>> START 1/2: BOT + GATEWAY <<<<<<<<<<"
bash "$HERE/start-bot-only.sh" || eko_rc=$?

echo ""
echo ">>>>>>>>>> START 2/2: LOCALTONET + MINER <<<<<<<<<<"
bash "$HERE/start-miner.sh" || yan_rc=$?

echo ""
echo "[start] UNIFIED done  ekos_rc=$eko_rc  yanez_rc=$yan_rc"
echo "  logs: bot_github.log gateway.log  |  logs/localtonet.log logs/miner.log"
echo "=============================================="

# postStart should not fail the Codespace if one stack is blocked;
# processes that passed gate are already detached.
exit 0
