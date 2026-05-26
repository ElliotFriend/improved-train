# AI Nurse MCP Server

An MCP (Model Context Protocol) server that gives an autonomous patient agent
the ability to consult the AI Nurse over the privacy-pool payment flow. Wires
into Claude Code (or any MCP-capable host) over stdio.

Pattern mirrored from
[stellar-observatory's mcp-server](../../stellar-observatory/mcp-server) — the
patient agent holds its own Stellar secret (no Freighter, no human clicks),
sees the nurse's 402 challenge, signs and submits the settlement, and returns
the advice to the calling LLM.

## Status: prover-stubbed scaffold

The handshake + payment-header retry are wired; the **settlement step**
(`proveTransact`) currently throws a `TODO` because the privacy-pool prover
is browser-only WASM. Plug in one of:

- A future Node-targeted build of the Nethermind prover (durable)
- A headless-Chrome sidecar exposing `/prove` (interim)
- Pre-funded notes + a non-private payment fallback (cheat)

See `src/consult-client.ts::settleChallenge` for the seam.

## Setup

```bash
cd mcp-server
pnpm install
pnpm build
```

## Wire into Claude Code

Edit `.mcp.json` at the repo root (see `.mcp.json.example`):

```json
{
    "mcpServers": {
        "ai-nurse": {
            "type": "stdio",
            "command": "node",
            "args": ["./mcp-server/build/index.js"],
            "env": {
                "PATIENT_STELLAR_SECRET": "S...",
                "MPP_DEMO_BASE_URL": "http://localhost:5173",
                "STELLAR_NETWORK": "testnet"
            }
        }
    }
}
```

## Env vars

| Variable                  | Required | Default                 | Description                                          |
| ------------------------- | -------- | ----------------------- | ---------------------------------------------------- |
| `PATIENT_STELLAR_SECRET`  | Yes      | —                       | Patient agent's Stellar secret (`S…`) for signing    |
| `MPP_DEMO_BASE_URL`       | No       | `http://localhost:5173` | Base URL of the SvelteKit app exposing `/api/a2a/*`  |
| `STELLAR_NETWORK`         | No       | `testnet`               | `testnet` or `pubnet`                                |
| `STELLAR_RPC_URL`         | No       | derived                 | Override Soroban RPC URL                             |

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
