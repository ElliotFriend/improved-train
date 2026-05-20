# A2A Private Payments Demo

A SvelteKit demo of agent-to-agent payments over the **Machine Payments Protocol (MPP)**,
settled through a **Stellar privacy pool**. A "patient agent" sends a medical
question to a "nurse agent"; the nurse replies HTTP 402 with a privacy-pool payment
challenge; the patient agent generates a Groth16 ZK proof and withdraws 1 XLM from
the pool to the nurse; the nurse verifies the on-chain settlement and replies with
Claude-generated guidance.

The privacy property: the nurse sees a withdrawal land in its account but the on-chain
state does not link it back to the patient's wallet — the depositor and the withdrawal
recipient are cryptographically unlinkable.

## Architecture

The SvelteKit request path has **no external binary dependencies** — proofs are
generated in-process with the `snarkjs` npm package, the proof + public signals are
encoded to the Soroban verifier's format by a small TS helper, and the `withdraw()`
invocation is built/signed/submitted via `@stellar/stellar-sdk`. Suitable for Vercel
or any other Node serverless runtime.

```
src/
  routes/
    a2a/+page.svelte                 Patient-side UI + protocol step viewer
    api/a2a/consult/+server.ts       Nurse endpoint (402 / verify / advise)
    api/a2a/pay/+server.ts           Patient endpoint (NDJSON stream)
  lib/
    a2a/server.ts                    snarkjs + stellar-sdk + Soroban encoding
    a2a/assets/                      Bundled wasm + zkey + withdrawal_input.json
scripts/
  a2a-setup.sh                       Dev-side: deploy a fresh pool, deposit a coin
  a2a-demo.sh                        Dev-side: CLI walk-through of the protocol
```

## Local dev

Toolchain (one-time, in the upstream privacy-pools repo):

- `circom`, `snarkjs`, `stellar`, `cargo`, `node`, `jq`, `python3` on PATH
- Circuits compiled (`circuits/build/main_js/main.wasm`)
- Groth16 trusted setup (`circuits/output/main_final.zkey`)
- `stellar-coinutils` and `stellar-circom2soroban` Rust binaries built

See `../soroban-examples/privacy-pools/README.md` for the recipe. Then:

```sh
pnpm install
cp .env.example .env   # fill in A2A_* + ANTHROPIC_API_KEY

# Deploy a fresh pool, deposit a coin, pin association root (writes .a2a/)
scripts/a2a-setup.sh

# Copy bundled assets so the function can read them at request time
cp ../soroban-examples/privacy-pools/circuits/build/main_js/main.wasm src/lib/a2a/assets/
cp ../soroban-examples/privacy-pools/circuits/output/main_final.zkey src/lib/a2a/assets/
../soroban-examples/privacy-pools/target/release/stellar-coinutils withdraw \
    .a2a/coin.json .a2a/state.json .a2a/association.json \
    -o src/lib/a2a/assets/withdrawal_input.json

# Point .env at the new pool
grep '^PRIVACY_POOL_ID' .a2a/contracts.env
# -> update A2A_PRIVACY_POOL_ID in .env

pnpm dev
```

Open <http://localhost:5173/a2a> or run `scripts/a2a-demo.sh`.

## Vercel deployment

The SvelteKit function reads `main.wasm`, `main_final.zkey`, and `withdrawal_input.json`
from `src/lib/a2a/assets/` at runtime via SvelteKit's `read()` helper, so all three
need to be committed (or rebundled at deploy time). With the Vercel adapter, the
bundle is shipped into the function. The zkey is ~12 MB; comfortable inside the
50 MB Hobby plan cap and trivial under Pro's 250 MB.

Required Vercel env vars:

- `A2A_NURSE_PUBLIC` / `A2A_NURSE_SECRET`
- `A2A_PRIVACY_POOL_ID` (must match the pool whose `withdrawal_input.json` is bundled)
- `A2A_NETWORK=testnet`
- `ANTHROPIC_API_KEY` (optional; placeholder advice if unset)

### One-shot per deploy

Each pool is single-use today because `lean-imt::insert` exceeds Soroban's budget on
the second deposit (CAP-75 pending). So each Vercel deploy is good for one
consultation — repeat the local-dev setup + rebundle + redeploy to refresh.

## Tech

- SvelteKit + Svelte 5 (runes)
- `snarkjs` npm for the Groth16 proof in-process
- `@stellar/stellar-sdk` (Soroban RPC + Horizon)
- Anthropic SDK for the nurse reply
- Testnet only
