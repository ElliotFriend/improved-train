# AI Nurse MCP Server

An MCP (Model Context Protocol) server that gives an autonomous patient agent
the ability to consult the AI Nurse over the privacy-pool payment flow. Wires
into Claude Code (or any MCP-capable host) over stdio.

Pattern mirrored from
[stellar-observatory's mcp-server](../../stellar-observatory/mcp-server) — the
patient agent sees the nurse's 402 challenge, settles it (no Freighter, no human
clicks), and returns the advice to the calling LLM.

## Architecture

This MCP server orchestrates the consult and **supervises** the prover. The
actual proving + signing lives in the [prover-sidecar](../prover-sidecar), which
it calls over HTTP:

```
ask-nurse({question})
  → ensureSidecar()                        ← starts + funds the prover if needed
  → POST nurse /api/a2a/consult           → 402 challenge
  → POST prover-sidecar /prove {challenge} → { txHash }   (proves + signs + submits)
  → POST nurse /api/a2a/consult + x-payment-tx → { advice }
```

**You don't start the sidecar by hand.** On the first `ask-nurse`, the supervisor
([`src/sidecar.ts`](src/sidecar.ts)):

1. health-checks `PROVER_SIDECAR_URL` — if a sidecar is already up (you ran one
   manually), it's reused as-is;
2. otherwise spawns `prover-sidecar/build/index.js` as a child process (the
   patient env is forwarded), and waits for `/health`;
3. if the patient has no spendable notes, runs the one-time bootstrap
   (`setup.js`: derive keys → register ASP → deposit) and waits for the indexer
   to surface them.

It's memoized, so this happens once per MCP-server lifetime, and the child is
killed when the MCP server exits. Because the supervisor spawns the sidecar, the
patient's `PATIENT_STELLAR_SECRET` now lives in **this** server's env (see
below) and is forwarded to the child — set `PROVER_SIDECAR_AUTOSTART=0` to opt
out and require an externally-managed sidecar instead.

## Setup

One-time build of both this server and the sidecar it supervises:

```bash
pnpm install
pnpm --filter mpp-demo-mcp build
pnpm --filter mpp-demo-prover-sidecar build
pnpm --filter mpp-demo-prover-sidecar exec playwright install chromium   # ~260MB, once
```

## Wire into Claude Code

Edit `.mcp.json` at the repo root (see `.mcp.json.example`). Drop in the
patient's testnet secret and you're done — no separate sidecar terminal:

```json
{
    "mcpServers": {
        "ai-nurse": {
            "type": "stdio",
            "command": "node",
            "args": ["./mcp-server/build/index.js"],
            "env": {
                "MPP_DEMO_BASE_URL": "http://localhost:5173",
                "PATIENT_STELLAR_SECRET": "S...your-patient-testnet-secret...",
                "PATIENT_ASP_BLINDING": "0"
            }
        }
    }
}
```

The first `ask-nurse` will spend ~20–60s warming the prover (headless Chromium +
WASM + chain sync) and, if the patient is unfunded, running the deposit
bootstrap. Subsequent consults are fast (the browser profile is persisted).

## Env vars

| Variable                         | Required           | Default                 | Description                                                          |
| -------------------------------- | ------------------ | ----------------------- | -------------------------------------------------------------------- |
| `MPP_DEMO_BASE_URL`              | No                 | `http://localhost:5173` | Base URL of the SvelteKit app exposing `/api/a2a/*`                  |
| `PROVER_SIDECAR_URL`             | No                 | `http://127.0.0.1:7878` | Prover sidecar that settles the payment                              |
| `PATIENT_STELLAR_SECRET`         | For auto-start     | —                       | Patient's Stellar secret; forwarded to the spawned sidecar           |
| `PATIENT_ASP_BLINDING`           | No                 | `0`                     | ASP membership blinding; forwarded to the sidecar                    |
| `PROVER_SIDECAR_AUTOSTART`       | No                 | `1`                     | `0` = never spawn; require an already-running sidecar                |
| `PROVER_SIDECAR_DIR`             | No                 | `../prover-sidecar/build` | Override the built-sidecar directory the supervisor spawns         |
| `PROVER_SIDECAR_BOOT_TIMEOUT_MS` | No                 | `180000`                | How long to wait for a freshly-spawned sidecar to report healthy     |
| `PROVER_SIDECAR_FUND_TIMEOUT_MS` | No                 | `90000`                 | How long to wait for notes to surface after a bootstrap deposit      |

`STELLAR_NETWORK` / `STELLAR_RPC_URL` / `PATIENT_DEPOSIT_XLM` are read by the
sidecar itself; set them here too and they're forwarded to the child. The
patient secret is only needed for auto-start — if you point `PROVER_SIDECAR_URL`
at a sidecar you started yourself, this server never touches the secret.

## Tools

| Tool            | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| `ask-nurse`     | Submit a consult question; pays the 402 challenge and returns the advice   |
| `get-challenge` | Fetch the nurse's payment challenge without paying — useful for previewing |

## Dev loop

```bash
pnpm dev    # tsx watch
```

Wire to Claude via `.mcp.json` pointing at `build/index.js` (run `pnpm build`
first, or use the dev script and update `args` to use `tsx`).
