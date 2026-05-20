# /a2a — Agent-to-Agent Payment Flow

Patient agent ↔ nurse agent, settled via Stellar payment on testnet.

## Protocol

1. **Patient calls nurse without payment** — `POST /api/a2a/consult { question }`
   → nurse responds **402** with `{ challenge: { recipient, amount, asset, network } }`.
2. **Patient agent runs payment protocol** — `POST /api/a2a/pay`
   → streams NDJSON: protocol steps, then a `settled` event with the tx hash.
3. **Patient retries with receipt** — `POST /api/a2a/consult` + `X-Payment-Tx: <hash>`
   → nurse verifies the tx on Horizon (correct from/to/asset/amount, successful),
   then calls Claude and returns the reply.

## Files

```
+page.svelte                          Patient UI + protocol step viewer
../api/a2a/consult/+server.ts         Nurse endpoint (402 / verify / advise)
../api/a2a/pay/+server.ts             Patient endpoint (NDJSON stream, submits settlement)
../../lib/a2a/server.ts               Payment + verification helpers
```

The patient and nurse keypairs both live server-side in `.env`. In a fuller
deployment they would be two independent services; collapsing them into one
SvelteKit server keeps the demo to a single command.
