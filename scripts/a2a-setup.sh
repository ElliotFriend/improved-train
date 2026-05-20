#!/usr/bin/env bash
# Setup: deploy a fresh privacy-pool, deposit COIN_COUNT coins, pin the
# association root, generate a withdrawal_input.json for each coin, and copy
# all assets the SvelteKit function needs (wasm + zkey + per-coin withdrawal
# inputs) into src/lib/a2a/assets/.
#
# With CAP-75 (Poseidon as a host function on Soroban protocol 26) a single
# pool can hold multiple coins. The on-chain association tree is depth 2, so
# COIN_COUNT is capped at 4.

set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.a2a"
ASSETS="$ROOT/src/lib/a2a/assets"
WITHDRAWALS="$ASSETS/withdrawals"
PP_DIR="${A2A_PRIVACY_POOLS_DIR:-$ROOT/../soroban-examples/privacy-pools}"
GROTH16_DIR="$PP_DIR/../groth16_verifier"
NETWORK="${A2A_NETWORK:-testnet}"
TOKEN_ADDRESS="${A2A_TOKEN_ADDRESS:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}" # XLM SAC testnet
ADMIN_ALIAS="${A2A_ADMIN_ALIAS:-a2a_admin}"
PATIENT_ALIAS="${A2A_PATIENT_ALIAS:-a2a_patient}"
SCOPE="${A2A_POOL_SCOPE:-a2a_pool}"
COIN_COUNT="${COIN_COUNT:-4}"

if [ "$COIN_COUNT" -gt 4 ] || [ "$COIN_COUNT" -lt 1 ]; then
    echo "COIN_COUNT must be 1..4 (association tree depth = 2)" >&2
    exit 1
fi

mkdir -p "$CACHE" "$WITHDRAWALS"
rm -f "$WITHDRAWALS"/*.json

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
header() { color '1;35' "==> $1"; }
ok() { color '0;32' "  + $1"; }
err() { color '0;31' "  x $1"; }

for cmd in jq stellar snarkjs node python3 cargo; do
    command -v "$cmd" >/dev/null 2>&1 || { err "$cmd not found in PATH"; exit 1; }
done

[ -f "$PP_DIR/target/release/stellar-coinutils" ] || {
    err "stellar-coinutils binary not built at $PP_DIR/target/release/"
    err "Run: cd $PP_DIR && cargo build --release --bin stellar-coinutils --bin stellar-circom2soroban"
    exit 1
}
[ -f "$PP_DIR/circuits/build/main_js/main.wasm" ] || {
    err "circuits not compiled at $PP_DIR/circuits/build/"
    exit 1
}
[ -f "$PP_DIR/circuits/output/main_final.zkey" ] || {
    err "circuits zkey not present at $PP_DIR/circuits/output/main_final.zkey"
    exit 1
}

header "Ensuring contract WASMs are built"
( cd "$GROTH16_DIR" && make build >/dev/null 2>&1 ) || { err "groth16_verifier build failed"; exit 1; }
( cd "$PP_DIR" && cargo build --target wasm32v1-none --release -p privacy-pools >/dev/null 2>&1 ) || { err "privacy_pools build failed"; exit 1; }
( cd "$PP_DIR" && stellar contract optimize --wasm target/wasm32v1-none/release/privacy_pools.wasm --wasm-out target/wasm32v1-none/release/privacy_pools.optimized.wasm >/dev/null 2>&1 )
( cd "$PP_DIR" && stellar contract optimize --wasm "$GROTH16_DIR/target/wasm32v1-none/release/soroban_groth16_verifier_contract.wasm" --wasm-out "$GROTH16_DIR/target/wasm32v1-none/release/soroban_groth16_verifier_contract.optimized.wasm" >/dev/null 2>&1 )
ok "WASMs ready"

GROTH16_ID="${A2A_GROTH16_VERIFIER_ID:-}"
if [ -z "$GROTH16_ID" ] && [ -f "$CACHE/contracts.env" ]; then
    GROTH16_ID=$(grep '^GROTH16_VERIFIER_ID=' "$CACHE/contracts.env" | cut -d= -f2)
fi

if [ -z "$GROTH16_ID" ]; then
    header "Deploying groth16_verifier"
    OUT=$(cd "$PP_DIR" && stellar contract deploy --wasm "$GROTH16_DIR/target/wasm32v1-none/release/soroban_groth16_verifier_contract.optimized.wasm" --source "$ADMIN_ALIAS" --network "$NETWORK" 2>&1)
    GROTH16_ID=$(echo "$OUT" | grep -oE 'C[A-Z0-9]{55}' | tail -1)
    [ -n "$GROTH16_ID" ] || { err "deploy failed"; echo "$OUT"; exit 1; }
    ok "groth16_verifier = $GROTH16_ID"
else
    ok "Reusing groth16_verifier = $GROTH16_ID"
fi

header "Deploying fresh privacy_pools"
VK_HEX=$(cd "$PP_DIR" && ./target/release/stellar-circom2soroban vk circuits/output/main_verification_key.json 2>/dev/null | grep -A1 "VK Hex encoding:" | tail -1)
OUT=$(cd "$PP_DIR" && stellar contract deploy --wasm target/wasm32v1-none/release/privacy_pools.optimized.wasm --source "$ADMIN_ALIAS" --network "$NETWORK" -- --vk_bytes "$VK_HEX" --token_address "$TOKEN_ADDRESS" --admin "$ADMIN_ALIAS" --groth16_verifier "$GROTH16_ID" 2>&1)
PP_ID=$(echo "$OUT" | grep -oE 'C[A-Z0-9]{55}' | tail -1)
[ -n "$PP_ID" ] || { err "deploy failed"; echo "$OUT"; exit 1; }
ok "privacy_pools = $PP_ID"

header "Generating $COIN_COUNT coins"
for i in $(seq 0 $((COIN_COUNT - 1))); do
    "$PP_DIR/target/release/stellar-coinutils" generate "$SCOPE" -o "$CACHE/coin_${i}.json" >/dev/null
    ok "coin_$i  commitment $(jq -r '.commitment_hex' "$CACHE/coin_${i}.json")"
done

header "Depositing $COIN_COUNT coins"
for i in $(seq 0 $((COIN_COUNT - 1))); do
    C=$(jq -r '.commitment_hex' "$CACHE/coin_${i}.json" | sed 's/^0x//')
    stellar contract invoke --id "$PP_ID" --source "$PATIENT_ALIAS" --network "$NETWORK" --send=yes -- deposit --from "$PATIENT_ALIAS" --commitment "$C" >/dev/null
    ok "coin_$i deposited at leaf index $i"
done

header "Building association set with all $COIN_COUNT labels"
rm -f "$CACHE/association.json"
for i in $(seq 0 $((COIN_COUNT - 1))); do
    LABEL=$(jq -r '.coin.label' "$CACHE/coin_${i}.json")
    "$PP_DIR/target/release/stellar-coinutils" update-association "$CACHE/association.json" "$LABEL" >/dev/null
done
ASSOC_DEC=$(jq -r '.root' "$CACHE/association.json")
ASSOC_HEX=$(python3 -c "import sys; print(hex(int(sys.argv[1]))[2:].zfill(64))" "$ASSOC_DEC")
stellar contract invoke --id "$PP_ID" --source "$ADMIN_ALIAS" --network "$NETWORK" --send=yes -- set_association_root --caller "$ADMIN_ALIAS" --association_root "$ASSOC_HEX" >/dev/null
ok "association root pinned"

header "Writing state file (all $COIN_COUNT commitments)"
COMMITS=$(for i in $(seq 0 $((COIN_COUNT - 1))); do jq -r '.coin.commitment' "$CACHE/coin_${i}.json"; done | jq -R . | jq -s .)
jq -n --argjson c "$COMMITS" --arg s "$SCOPE" '{commitments: $c, scope: $s}' > "$CACHE/state.json"
ok "state.json written ($(jq '.commitments | length' "$CACHE/state.json") commitments)"

header "Generating $COIN_COUNT withdrawal inputs"
for i in $(seq 0 $((COIN_COUNT - 1))); do
    "$PP_DIR/target/release/stellar-coinutils" withdraw "$CACHE/coin_${i}.json" "$CACHE/state.json" "$CACHE/association.json" -o "$WITHDRAWALS/${i}.json" >/dev/null
    ok "withdrawals/${i}.json  (leaf index $i)"
done

header "Pre-computing nullifier hashes (so the server can pick an unused coin)"
PROVE_TMP=$(mktemp -d -t a2a-prove)
NULL_HASHES=""
for i in $(seq 0 $((COIN_COUNT - 1))); do
    node "$PP_DIR/circuits/build/main_js/generate_witness.js" "$PP_DIR/circuits/build/main_js/main.wasm" "$WITHDRAWALS/${i}.json" "$PROVE_TMP/witness.wtns" >/dev/null
    snarkjs groth16 prove "$PP_DIR/circuits/output/main_final.zkey" "$PROVE_TMP/witness.wtns" "$PROVE_TMP/proof.json" "$PROVE_TMP/public.json" >/dev/null
    NH=$(jq -r '.[0]' "$PROVE_TMP/public.json")
    NULL_HASHES="${NULL_HASHES}\"$NH\","
    ok "coin_$i nullifier_hash = ${NH:0:24}..."
done
NULL_HASHES="[${NULL_HASHES%,}]"
echo "$NULL_HASHES" | jq . > "$ASSETS/nullifier_hashes.json"
rm -rf "$PROVE_TMP"
ok "nullifier_hashes.json bundled"

header "Bundling circuit assets into src/lib/a2a/assets/"
cp "$PP_DIR/circuits/build/main_js/main.wasm" "$ASSETS/main.wasm"
cp "$PP_DIR/circuits/output/main_final.zkey" "$ASSETS/main_final.zkey"
# Drop the legacy single-coin bundle if present
rm -f "$ASSETS/withdrawal_input.json"
ok "main.wasm + main_final.zkey + withdrawals/*.json bundled"

header "Writing contracts.env"
cat > "$CACHE/contracts.env" <<EOF
PRIVACY_POOL_ID=$PP_ID
GROTH16_VERIFIER_ID=$GROTH16_ID
PRIVACY_POOLS_DIR=$PP_DIR
COIN_COUNT=$COIN_COUNT
EOF
ok "ready"

echo
color '1;32' "+ Setup complete -- $COIN_COUNT coins deposited."
color '1;32' "  Update .env: A2A_PRIVACY_POOL_ID=$PP_ID"
color '1;32' "  Start: pnpm dev"
