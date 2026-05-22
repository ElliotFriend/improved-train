#!/usr/bin/env bash
# Open the /setup-nurse page with the nurse's Stellar secret + blinding in the
# URL hash so the page can derive privacy keys and self-register in ASP.
#
# Usage:
#   STELLAR_SECRET=SXXX... BLINDING=1 ./scripts/setup-nurse.sh [base-url]
#
# Notes:
#   - The dev server must be running (pnpm dev). Default base-url is
#     http://localhost:5173.
#   - Secret stays in the URL hash, never sent to the server.
#   - The page is deterministic: re-running with the same secret + blinding
#     re-derives the same pubkeys.
#   - After it finishes, paste the printed env block into .env and restart dev.

set -euo pipefail

BASE_URL="${1:-http://localhost:5173}"
BLINDING="${BLINDING:-1}"

if [[ -z "${STELLAR_SECRET:-}" ]]; then
    echo "STELLAR_SECRET env var is required" >&2
    echo "  e.g. STELLAR_SECRET=SXXX... ./scripts/setup-nurse.sh" >&2
    exit 1
fi

URL="${BASE_URL}/setup-nurse#secret=${STELLAR_SECRET}&blinding=${BLINDING}"

if command -v open >/dev/null 2>&1; then
    open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
else
    echo "Open this URL in your browser to finish setup:"
    echo "  $URL"
fi
