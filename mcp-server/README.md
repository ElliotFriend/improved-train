# AI Nurse MCP Server

An MCP (Model Context Protocol) server that gives an autonomous patient agent
the ability to consult the AI Nurse over the privacy-pool payment flow. Wires
into Claude Code (or any MCP-capable host) over stdio.

Pattern mirrored from
[stellar-observatory's mcp-server](../../stellar-observatory/mcp-server) — the
patient agent sees the nurse's 402 challenge, settles it (no Freighter, no human
clicks), and returns the advice to the calling LLM.

## Architecture

This MCP server is pure orchestration. It does **not** hold the patient's
Stellar secret or do any proving — that lives in the
[prover-sidecar](../prover-sidecar), which it calls over HTTP:

```
ask-nurse({question})
  → POST nurse /api/a2a/consult           → 402 challenge
  → POST prover-sidecar /prove {challenge} → { txHash }   (proves + signs + submits)
  → POST nurse /api/a2a/consult + x-payment-tx → { advice }
```

Run the prover-sidecar first (it owns `PATIENT_STELLAR_SECRET`).

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
                "MPP_DEMO_BASE_URL": "http://localhost:5173",
                "PROVER_SIDECAR_URL": "http://127.0.0.1:7878"
            }
        }
    }
}
```

## Env vars

| Variable             | Required | Default                  | Description                                         |
| -------------------- | -------- | ------------------------ | --------------------------------------------------- |
| `MPP_DEMO_BASE_URL`  | No       | `http://localhost:5173`  | Base URL of the SvelteKit app exposing `/api/a2a/*` |
| `PROVER_SIDECAR_URL` | No       | `http://127.0.0.1:7878`  | Prover sidecar that settles the payment             |

The patient's Stellar secret lives in the **prover-sidecar**, not here.

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
