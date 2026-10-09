# Codespace Unified — Ekosistem + Yanez Mining SN54

Satu Codespace menjalankan dua stack:

1. **Ekosistem** — `bot_github` + `gateway` (Camoufox, Upstash, proxy)
2. **Yanez Mining** — `localtonet` + `neurons/miner.py` (API offload, axon, wallet)

## Lifecycle

| Hook | Script |
|------|--------|
| postCreate | `.devcontainer/setup.sh` → setup-ekos + setup-yanez |
| postStart | `.devcontainer/start-all.sh` → start-bot-only + start-miner |

## Logs

```bash
tail -f bot_github.log gateway.log
tail -f logs/localtonet.log logs/miner.log
tail -f MIID-subnet/monitor_tambang.txt
```

## Manual restart

```bash
bash .devcontainer/start-bot-only.sh
bash .devcontainer/start-miner.sh
# or both:
bash .devcontainer/start-all.sh
```

## Layout penting

- `vendor/MIID/` — full package PC (protocol+validator synced)
- `vendor/neurons/miner.py` — miner PC
- `custom/` — mirror inject files
- `wallets/wallet_mainnet/`
- `.env` — keys ekosistem + yanez digabung

Jangan campur protocol upstream GitHub; selalu inject dari `vendor/`.
