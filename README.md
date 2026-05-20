# A2A Private Payments Demo

A SvelteKit demo of agent-to-agent payments over the **Machine Payments Protocol (MPP)**,
settled through a **Stellar privacy pool**. A "patient agent" sends a medical
question to a "nurse agent"; the nurse replies HTTP 402 with a privacy-pool payment
challenge; the patient agent generates a Groth16 ZK proof and withdraws 1 XLM from the
pool to the nurse; the nurse verifies the on-chain settlement and replies with
Claude-generated guidance.

The privacy property: the nurse sees a withdrawal land in its account but the on-chain
state does not link it back to the patient's wallet — the depositor and the withdrawal
recipient are cryptographically unlinkable.

## Layout

```
src/
  routes/
    a2a/+page.svelte                 Patient-side UI + protocol step viewer
    api/a2a/consult/+server.ts       Nurse endpoint (402 / verify / advise)
    api/a2a/pay/+server.ts           Patient endpoint (NDJSON stream)
  lib/
    a2a/server.ts                    Drives coinutils + snarkjs + stellar CLI
scripts/
  a2a-setup.sh                       Deploy a fresh pool, deposit a coin, pin assoc root
  a2a-demo.sh                        CLI walk-through (curl + jq)
.a2a/                                Coin secrets + state + deployed contract IDs (gitignored)
```

## Running it

First-time toolchain setup happens in the upstream privacy-pools repo (separate from
this directory). You need:

- `circom`, `snarkjs`, `stellar`, `cargo`, `node`, `jq`, `python3` on PATH.
- The privacy-pools circuits compiled (`circuits/build/main_js/main.wasm`).
- A Groth16 trusted setup (`circuits/output/main_final.zkey`).
- The `stellar-coinutils` and `stellar-circom2soroban` Rust binaries built.

See `../soroban-examples/privacy-pools/README.md` for the recipe. With that in place:

```sh
pnpm install
cp .env.example .env   # fill in A2A_* + ANTHROPIC_API_KEY

# One-shot per demo run: deploy fresh pool, deposit a coin, pin association root
scripts/a2a-setup.sh

pnpm dev
```

Open <http://localhost:5173/a2a> in a browser, or run the CLI walk-through:

```sh
scripts/a2a-demo.sh
```

## One-shot limitation

The on-chain `lean-imt::insert` exceeds Soroban's resource budget on the **second**
deposit into the same pool (a known limitation noted in the upstream privacy-pools
README, awaiting Poseidon as a host function via [CAP-75]). So today each pool is
usable for one withdrawal — `scripts/a2a-setup.sh` deploys a fresh pool each time
to refresh.

[CAP-75]: https://github.com/stellar/stellar-protocol/blob/master/core/cap-0075.md

## Tech

- SvelteKit + Svelte 5 (runes)
- Soroban + `@stellar/stellar-sdk` (Horizon, signed transactions via `stellar` CLI)
- Circom + snarkjs for the Groth16 proof (BLS12-381)
- Anthropic SDK for the nurse reply
- Testnet only
