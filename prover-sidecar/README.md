# Prover Sidecar

The privacy-pool prover backend for the autonomous patient agent. Hosts the
browser-only stellar-private-payments WASM inside a headless Chromium (driven by
Playwright) and exposes an HTTP `/prove` endpoint, so the Node-side MCP server
can settle consult payments without Freighter or a human in the loop.

This is the **headless-Chrome sidecar** approach (chosen over a Node-targeted
WASM port for speed-to-demo; see the project history). It holds the patient's
Stellar secret and does all signing + proving + submission.

## Architecture

```
MCP server ──POST /prove {challenge}──▶ prover-sidecar (:7878)
                                          │
                                          ├─ Playwright headless Chromium
                                          │    └─ public/prover.html
                                          │         └─ /spp/js/web.js (WASM)
                                          │              ├ storage-worker (OPFS-SQLite indexer)
                                          │              └ prover-worker (Groth16; circuits
                                          │                 fetched from nethermindeth.github.io)
                                          └─ Node submit (stellar-sdk + local Keypair)
                                               └─ Soroban RPC ──▶ pool transact()
```

The page proves; Node signs + submits. The patient secret never enters the
browser context.

> **You usually don't run this directly.** The [MCP server](../mcp-server)
> supervises this sidecar — it spawns it, waits for `/health`, and runs the
> bootstrap automatically on the first consult. The manual steps below are for
> standalone use / debugging, or if you set `PROVER_SIDECAR_AUTOSTART=0`.

## Prereqs

```bash
pnpm install
pnpm exec playwright install chromium    # one-time, ~260MB
```

## One-time patient setup

Derive keys, register in ASP membership, and deposit XLM so the patient has
notes to spend:

```bash
PATIENT_STELLAR_SECRET=S... \
PATIENT_DEPOSIT_XLM=50 \
PATIENT_ASP_BLINDING=0 \
pnpm --filter mpp-demo-prover-sidecar bootstrap
```

## Run the sidecar

```bash
PATIENT_STELLAR_SECRET=S... \
PATIENT_ASP_BLINDING=0 \
pnpm --filter mpp-demo-prover-sidecar start   # (build first) or `dev` for tsx watch
```

Then:

```bash
curl localhost:7878/health
# { "ok": true, "address": "G…", "notes": 1, "unspentStroops": "500000000" }
```

## Env vars

| Variable                  | Required | Default                            | Description                                    |
| ------------------------- | -------- | ---------------------------------- | ---------------------------------------------- |
| `PATIENT_STELLAR_SECRET`  | Yes      | —                                  | Patient agent's Stellar secret (`S…`)          |
| `PATIENT_ASP_BLINDING`    | No       | `0`                                | ASP membership blinding (must match register)  |
| `STELLAR_NETWORK`         | No       | `testnet`                          | `testnet` or `pubnet`                          |
| `STELLAR_RPC_URL`         | No       | per network                        | Soroban RPC override                           |
| `PROVER_SIDECAR_PORT`     | No       | `7878`                             | Port for the `/prove` + `/health` server       |
| `PATIENT_DEPOSIT_XLM`     | No       | `50`                               | (bootstrap only) deposit amount                |
| `SPP_STATIC_DIR`          | No       | `../static/spp`                    | Override the served WASM bundle dir            |
| `PROVER_USER_DATA_DIR`    | No       | `./.prover-profile`                | Persistent Chromium profile (OPFS note index)  |

## Endpoints

| Method | Path      | Body            | Returns                                            |
| ------ | --------- | --------------- | -------------------------------------------------- |
| GET    | `/health` | —               | `{ ok, address, notes, unspentStroops }`           |
| POST   | `/prove`  | `{ challenge }` | `{ txHash }` — settled in-pool transfer to nurse   |

## Known rough edges (demo-grade)

- **Cold start:** the first-ever boot re-syncs the chain before `/health` shows
  notes (tens of seconds). After that it's fast — the headless browser now runs
  in a persistent context (`userDataDir`, default `./.prover-profile`, override
  with `PROVER_USER_DATA_DIR`), so OPFS and the note index survive restarts.
- **Single-writer:** `/prove` calls are serialized (the storage worker is
  single-tab). Concurrent consults queue.
- **Network:** the prover worker fetches circuit artifacts from
  `nethermindeth.github.io`; the sidecar needs outbound access there.
- **Not for Vercel:** this is a local/self-hosted companion, not a serverless
  function. See the project notes on hosted-proving constraints.
