# A2A Payments Demo

A SvelteKit demo of agent-to-agent payments over the **Machine Payments Protocol (MPP)**
on Stellar testnet. A "patient agent" sends a medical question to a "nurse agent";
the nurse replies HTTP 402 with a payment challenge; the patient agent settles a
Stellar payment autonomously and retries with the receipt; the nurse verifies the
settlement on Horizon and replies with Claude-generated guidance.

## Scope

This demo focuses on the **payment leg** of agent-to-agent commerce — the 402
challenge, the settlement, the receipt verification, and the protected response.
How the patient *acquires* spendable balance (e.g. via a privacy pool deposit
upstream) and how the nurse later *spends* or *exits* (e.g. via a privacy pool
withdrawal downstream) are deliberately out of scope.

## Running it

```sh
pnpm install
cp .env.example .env   # then fill in A2A_* keys (and optionally ANTHROPIC_API_KEY)
pnpm dev
```

Open <http://localhost:5173/a2a> in a browser, or run the CLI walk-through:

```sh
./scripts/a2a-demo.sh
```

Both drive the same three-step protocol against the testnet.

## Layout

```
src/
  routes/
    a2a/+page.svelte                 Patient-side UI + protocol step viewer
    api/a2a/consult/+server.ts       Nurse endpoint (402 / verify / advise)
    api/a2a/pay/+server.ts           Patient endpoint (NDJSON stream, submits settlement)
  lib/
    a2a/server.ts                    Stellar payment + verification helpers
    components/ui/                   Header / Footer / TruncatedAddress
scripts/
  a2a-demo.sh                        End-to-end CLI walk-through (curl + jq)
```

## Tech

- SvelteKit + Svelte 5 (runes)
- `@stellar/stellar-sdk` (Horizon + transaction building)
- `@anthropic-ai/sdk` for the nurse reply
- Testnet only — keys live in `.env` and are server-side
