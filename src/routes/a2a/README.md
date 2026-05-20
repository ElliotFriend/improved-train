# /a2a — Agent-to-Agent Private Payment Flow

Patient agent ↔ nurse agent, settled via a real Stellar privacy-pool withdrawal.

## Protocol

1. **Patient calls nurse without payment** — `POST /api/a2a/consult { question }`
   → nurse responds **402** with `{ challenge: { recipient, amount, contractId, ... } }`.
2. **Patient agent runs payment protocol** — `POST /api/a2a/pay`
   → server streams NDJSON: `snarkjs.groth16.fullProve()` generates the witness + Groth16
   proof in-process, a small TS helper encodes the proof + public signals for Soroban,
   and `@stellar/stellar-sdk` builds, signs (with the nurse keypair) and submits the
   `withdraw()` invocation. Final event carries the tx hash.
3. **Patient retries with receipt** — `POST /api/a2a/consult` + `X-Payment-Tx: <hash>`
   → nurse verifies the tx on Horizon (successful, source = nurse), then calls Claude
   and returns the reply.

No external binaries are shelled out. The function bundle ships `main.wasm` + `main_final.zkey`
+ the precomputed `withdrawal_input.json`; everything else happens in-process.

## Why the nurse signs

The pool's `withdraw(to, proof, pub_signals)` does `to.require_auth()`, so the
**recipient** must authorize the transaction. The patient generates the proof
off-chain and hands it to the nurse, which builds and signs the invocation. This
means the nurse opting in to receive a privacy-pool payment is explicit — payments
can't be forced onto an unwilling recipient.

## Bundled assets (Vercel-friendly)

```
src/lib/a2a/assets/
  main.wasm                  circom-compiled withdrawal circuit (~1.2 MB)
  main_final.zkey            Groth16 zkey (~12 MB)
  withdrawal_input.json      precomputed coin + state + association inputs
```

These are produced by `scripts/a2a-setup.sh` (which deploys a fresh pool, deposits a
coin, pins the association root, and writes the artifacts to `.a2a/`) plus a manual
copy into `src/lib/a2a/assets/` of `withdrawal_input.json`, `main.wasm` and
`main_final.zkey`. The `A2A_PRIVACY_POOL_ID` env var pairs the bundle with the
deployed pool.

Each pool is single-use today (CAP-75 / Soroban budget on the second deposit), so
each Vercel deploy is good for one consultation. Re-run setup + re-bundle + re-deploy
to refresh.

## Files

```
+page.svelte                          Patient UI + protocol step viewer
../api/a2a/consult/+server.ts         Nurse endpoint (402 / verify / advise)
../api/a2a/pay/+server.ts             Patient endpoint (NDJSON stream)
../../lib/a2a/server.ts               snarkjs + stellar-sdk + Soroban encoding
../../lib/a2a/assets/                 Bundled wasm + zkey + withdrawal input
```
