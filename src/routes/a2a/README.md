# /a2a — Agent-to-Agent Private Payment Flow

Patient agent ↔ nurse agent, settled via a real Stellar privacy-pool withdrawal.

## Protocol

1. **Patient calls nurse without payment** — `POST /api/a2a/consult { question }`
   → nurse responds **402** with `{ challenge: { recipient, amount, contractId, ... } }`.
2. **Patient agent runs payment protocol** — `POST /api/a2a/pay`
   → server streams NDJSON: `coinutils withdraw` builds witness inputs, `node` runs the
   circom circuit to produce a witness, `snarkjs groth16 prove` generates the Groth16
   proof, `circom2soroban` encodes it for the Soroban verifier, and `stellar contract
   invoke withdraw` ships it. Final event carries the tx hash.
3. **Patient retries with receipt** — `POST /api/a2a/consult` + `X-Payment-Tx: <hash>`
   → nurse verifies the tx on Horizon (successful, source = nurse), then calls Claude
   and returns the reply.

## Why the nurse signs

The pool's `withdraw(to, proof, pub_signals)` does `to.require_auth()`, so the
**recipient** must authorize the transaction. The patient generates the proof
off-chain and hands it to the nurse, which builds and signs the invocation. This
means the nurse opting in to receive a privacy-pool payment is explicit — payments
can't be forced onto an unwilling recipient.

## Files

```
+page.svelte                          Patient UI + protocol step viewer
../api/a2a/consult/+server.ts         Nurse endpoint (402 / verify / advise)
../api/a2a/pay/+server.ts             Patient endpoint (NDJSON stream)
../../lib/a2a/server.ts               Real coinutils + snarkjs + stellar wiring
```

The patient and nurse keypairs both live server-side. The nurse keypair is
referenced via `stellar-cli` alias so the CLI handles `to.require_auth()` signing.
