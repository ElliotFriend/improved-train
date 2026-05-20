# /a2a — Agent-to-Agent Private Payment (stellar-private-payments)

Patient agent runs in the **browser** (Nethermind stellar-private-payments WASM);
nurse stays server-side. The patient generates a Groth16 withdrawal proof locally,
signs the resulting `transact()` invocation through Freighter, and submits via
Soroban RPC. The nurse just verifies the on-chain tx and returns the reply.

## Flow

```
patient browser  → nurse server : POST /api/a2a/consult { question }
nurse server     → patient      : 402 + { recipient, amountStroops, pool, asp_* }
patient browser  : connect Freighter, derive privacy keys (one-time, 2 signMessage prompts)
patient browser  : pick input notes whose sum ≥ amount; client.proveWithdraw(...)
patient browser  : submitProvedPoolTransact via Freighter → tx hash
patient browser  → nurse server : POST /api/a2a/consult + X-Payment-Tx
nurse server     : RPC getTransaction → SUCCESS + targets pool contract → Claude reply
```

## Files

```
+page.svelte                  Patient UI: phases (init/wallet/keys/ready/asking/replied)
../api/a2a/consult/+server.ts Nurse endpoint (402 / verify / reply)
../../lib/a2a/server.ts       Soroban RPC verifier (envelope-decode + pool-id check)
../../lib/spp/                Vendored upstream JS facades (wallet, stellar, wasm-facade)
/static/spp/                  Vendored WASM bundle + circuits + LGPL legal files
```

## Contracts

Uses the Nethermind testnet deployment as-is (no fresh deploy needed):

- pool: `CAR5DPP35QGWZAYGOHYNGE5WBVI4BXDGT5MRAYYGG6UT64Y4LVKB3EJX`
- asp_membership: `CDXEYQIMM2TRFDO3E4XSILWEB4GOJXZO7D42KYYQYO4HMFAVBCEDQ2C6`
- asp_non_membership: `CAWCTK7Y2TS6SMGWLTIZURRKN3JN4WZPF4ZIROVRVL5KCCMVVFHMSYZU`
- verifier: `CA5A3TGKHMAQIZPKNAWKU2NFHR4Z57UUVHLHU75Z4OUQV6K7RBRVFQHB`

## Known gaps (scaffolding-only at this commit)

- **ASP registration**: `proveWithdraw` only succeeds for users whose pubkey is
  in the upstream ASP membership tree, whose admin is
  `GDF4BXPQY5N4BEO24UIHM4NVB62MW7HDWH7SVHKLVZAMLP5IIHCFQORC`. The patient will
  hit "ASP registration required" until added (either via that admin or by
  deploying our own pool with us as admin).
- **No deposit UI**: the patient needs notes in the pool to withdraw. Currently
  the page assumes they exist; we'll need a "Deposit" sub-flow to seed them.
- **Worker URL patch**: spp's Rust spawns workers as `./js/storage-worker.js`,
  resolved against the page base. `$lib/spp/wasm-facade.js` monkey-patches the
  `Worker` constructor to rewrite those to `/spp/js/*`. Brittle; ideally
  upstream takes a `worker_base_url` config.

## Wallet & WASM init

```js
// On mount (browser-only):
const { initializeWasm } = await import('$lib/spp/wasm-facade.js');
const handle = await initializeWasm('https://soroban-testnet.stellar.org');
const client = handle.client();
```

The `initializeWasm` helper monkey-patches `window.Worker` (for spp worker URLs)
and dynamically imports `/spp/js/web.js` via a `Function()` trick to keep
Rollup's static resolver from trying to bundle the runtime asset.
