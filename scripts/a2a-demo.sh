#!/usr/bin/env bash
# End-to-end demo of the agent-to-agent private medical consult flow.
#
# Walks through the same protocol the /a2a UI does, but from the shell:
#   1. patient asks the nurse (no payment) -> expects 402 with challenge
#   2. patient runs its private-payment protocol -> server settles on testnet
#   3. patient retries the ask with the receipt -> nurse verifies + replies
#
# Requires the SvelteKit dev server to be running (pnpm dev) on $BASE_URL.

set -euo pipefail
export LC_ALL=C

BASE_URL="${BASE_URL:-http://localhost:5173}"
QUESTION="${QUESTION:-Ive had a dull headache and mild dizziness on and off for three days, no fever. Should I worry?}"

if ! command -v jq >/dev/null 2>&1; then
    echo "jq is required (brew install jq)" >&2
    exit 1
fi

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
header() { color '1;35' "==> $1"; }
ok() { color '0;32' "  + $1"; }
info() { color '0;90' "  $1"; }
err() { color '0;31' "  x $1"; }

if ! curl -sf -o /dev/null -m 3 "${BASE_URL}/"; then
    err "Dev server not reachable at ${BASE_URL} -- run 'pnpm dev' in another shell."
    exit 1
fi

PAYLOAD=$(jq -nc --arg q "$QUESTION" '{question: $q}')

echo
header "Step 1 -- Patient agent calls the nurse without payment"
info "POST ${BASE_URL}/api/a2a/consult"
INITIAL=$(curl -s -X POST "${BASE_URL}/api/a2a/consult" \
    -H 'content-type: application/json' \
    -d "$PAYLOAD")
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/api/a2a/consult" \
    -H 'content-type: application/json' \
    -d "$PAYLOAD")
if [ "$STATUS" != "402" ]; then
    err "Expected 402, got $STATUS"
    echo "$INITIAL" | jq .
    exit 1
fi
ok "Received 402 Payment Required from nurse agent"
echo "$INITIAL" | jq '.challenge | {
    scheme,
    recipient,
    amount: (.amount + " XLM"),
    privacy_pool_contract: .contractId,
    groth16_verifier_contract: .groth16VerifierId,
    commitment_in_pool: .commitment
}' | sed 's/^/    /'

echo
header "Step 2 -- Patient agent runs private-payment protocol"
info "POST ${BASE_URL}/api/a2a/pay  (NDJSON stream)"
TMP=$(mktemp -t a2a-pay)
curl -sN -X POST "${BASE_URL}/api/a2a/pay" -o "$TMP"
HASH=""
while IFS= read -r line; do
    kind=$(echo "$line" | jq -r '.kind')
    case "$kind" in
        step)
            label=$(echo "$line" | jq -r '.label')
            detail=$(echo "$line" | jq -r '.detail // ""')
            if [ -n "$detail" ]; then
                ok "$label -- $detail"
            else
                ok "$label"
            fi
            ;;
        settled)
            HASH=$(echo "$line" | jq -r '.hash')
            LEDGER=$(echo "$line" | jq -r '.ledger')
            EXPLORER=$(echo "$line" | jq -r '.explorer')
            color '1;32' "  >> settled on ledger ${LEDGER}"
            info "tx ${HASH}"
            info "${EXPLORER}"
            ;;
        error)
            err "$(echo "$line" | jq -r '.message')"
            exit 1
            ;;
    esac
done < "$TMP"
rm -f "$TMP"

if [ -z "${HASH}" ]; then
    err "No settlement tx hash captured"
    exit 1
fi

echo
header "Step 3 -- Patient retries with payment receipt"
info "POST ${BASE_URL}/api/a2a/consult  X-Payment-Tx: ${HASH%${HASH#????????????}}..."
RESPONSE=$(curl -s -X POST "${BASE_URL}/api/a2a/consult" \
    -H 'content-type: application/json' \
    -H "x-payment-tx: ${HASH}" \
    -d "$PAYLOAD")
ADVICE=$(echo "$RESPONSE" | jq -r '.advice // empty')
if [ -z "$ADVICE" ]; then
    err "No advice returned"
    echo "$RESPONSE" | jq .
    exit 1
fi
ok "Nurse verified settlement on Horizon and replied"

echo
header "Nurse agent reply"
echo "$ADVICE" | fold -s -w 88 | sed 's/^/  /'

echo
color '1;32' "+ End-to-end agent-to-agent private payment flow complete."
