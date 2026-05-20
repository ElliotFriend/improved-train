#!/usr/bin/env bash
# One-shot setup: deploy a fresh privacy-pool, generate a coin, deposit it,
# pin the association root on the contract, and save everything the dev server
# needs into .a2a/ so the next /a2a request can spend the coin with a real
# Groth16 withdrawal.
#
# Privacy-pool inserts are budget-limited on Soroban today, so each pool is
# usable for ONE withdrawal. Re-run this script between demo runs to refresh.

set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.a2a"
PP_DIR="${A2A_PRIVACY_POOLS_DIR:-$ROOT/../soroban-examples/privacy-pools}"
GROTH16_DIR="$PP_DIR/../groth16_verifier"
NETWORK="${A2A_NETWORK:-testnet}"
TOKEN_ADDRESS="${A2A_TOKEN_ADDRESS:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}" # XLM SAC testnet
ADMIN_ALIAS="${A2A_ADMIN_ALIAS:-a2a_admin}"
PATIENT_ALIAS="${A2A_PATIENT_ALIAS:-a2a_patient}"
SCOPE="${A2A_POOL_SCOPE:-a2a_pool}"

mkdir -p "$CACHE"

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
    err "See $PP_DIR/README.md for circuit + trusted-setup recipe."
    exit 1
}
[ -f "$PP_DIR/circuits/output/main_final.zkey" ] || {
    err "circuits zkey not present at $PP_DIR/circuits/output/main_final.zkey"
    err "Run the trusted setup per $PP_DIR/README.md."
    exit 1
}

header "Ensuring contract WASMs are built"
( cd "$GROTH16_DIR" && make build >/dev/null 2>&1 ) || {
    err "groth16_verifier build failed"; exit 1
}
( cd "$PP_DIR" && cargo build --target wasm32v1-none --release -p privacy-pools >/dev/null 2>&1 ) || {
    err "privacy_pools build failed"; exit 1
}
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

header "Generating coin"
"$PP_DIR/target/release/stellar-coinutils" generate "$SCOPE" -o "$CACHE/coin.json" >/dev/null
COMMIT_HEX=$(jq -r '.commitment_hex' "$CACHE/coin.json" | sed 's/^0x//')
ok "commitment $COMMIT_HEX"

header "Depositing coin"
stellar contract invoke --id "$PP_ID" --source "$PATIENT_ALIAS" --network "$NETWORK" --send=yes -- deposit --from "$PATIENT_ALIAS" --commitment "$COMMIT_HEX" >/dev/null
ok "deposited"

header "Setting association root"
LABEL=$(jq -r '.coin.label' "$CACHE/coin.json")
"$PP_DIR/target/release/stellar-coinutils" update-association "$CACHE/association.json" "$LABEL" >/dev/null
ASSOC_DEC=$(jq -r '.root' "$CACHE/association.json")
ASSOC_HEX=$(python3 -c "import sys; print(hex(int(sys.argv[1]))[2:].zfill(64))" "$ASSOC_DEC")
stellar contract invoke --id "$PP_ID" --source "$ADMIN_ALIAS" --network "$NETWORK" --send=yes -- set_association_root --caller "$ADMIN_ALIAS" --association_root "$ASSOC_HEX" >/dev/null
ok "association root pinned"

header "Writing state file"
COMMIT_DEC=$(jq -r '.coin.commitment' "$CACHE/coin.json")
cat > "$CACHE/state.json" <<EOF
{
  "commitments": ["$COMMIT_DEC"],
  "scope": "$SCOPE"
}
EOF
ok "state.json written"

header "Writing contracts.env"
cat > "$CACHE/contracts.env" <<EOF
PRIVACY_POOL_ID=$PP_ID
GROTH16_VERIFIER_ID=$GROTH16_ID
PRIVACY_POOLS_DIR=$PP_DIR
EOF
# also clear any spent-flag from a previous run
rm -f "$CACHE/spent"
ok "ready"

echo
color '1;32' "+ Setup complete. Start the dev server (pnpm dev) and call /a2a to spend the coin."
