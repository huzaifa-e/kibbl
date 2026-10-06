#!/bin/bash
# Renews the Google Health access of a kibbl. user. While the Google OAuth app is in
# testing mode, Google ends a token after 7 days: this asks for a new consent in the
# browser (whoofit's gh_auth.py, its OAuth client and localhost redirect) and imports
# the new token on the server. The token goes through ssh stdin only, never an argument.
#
#   ./deploy/renew-health-token.sh user@example.com
#   HOST=jh@100.84.217.119 SSH_PORT=4711 ./deploy/renew-health-token.sh user@example.com
#   ./deploy/renew-health-token.sh --import-only user@example.com    the current token, no consent
#
# WHOOFIT_DIR: the whoofit checkout with its .env and .venv (default: next to this repository)

set -euo pipefail

HOST="${HOST:-jhubuntu}"
SSH=(ssh ${SSH_PORT:+-p "$SSH_PORT"})
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHOOFIT_DIR="${WHOOFIT_DIR:-$ROOT/../whoofit}"

consent=1
if [ "${1:-}" = "--import-only" ]; then
    consent=0
    shift
fi
EMAIL="${1:-}"
if [ -z "$EMAIL" ]; then
    echo "usage: $0 [--import-only] <kibbl user e-mail>" >&2
    exit 1
fi
TOKEN="$WHOOFIT_DIR/gh_token.json"

if [ "$consent" = 1 ]; then
    if [ ! -x "$WHOOFIT_DIR/.venv/bin/python" ] || [ ! -f "$WHOOFIT_DIR/gh_auth.py" ]; then
        echo "whoofit not found at $WHOOFIT_DIR (set WHOOFIT_DIR)" >&2
        exit 1
    fi
    before=$(stat -f %m "$TOKEN" 2>/dev/null || echo 0)
    echo "Opening the Google consent in the browser..."
    # gh_auth.py reads the OAuth client from whoofit's .env in its own folder
    (cd "$WHOOFIT_DIR" && .venv/bin/python gh_auth.py)
    after=$(stat -f %m "$TOKEN" 2>/dev/null || echo 0)
    if [ "$after" = "$before" ]; then
        echo "No new token was written, nothing imported." >&2
        exit 1
    fi
fi

if [ ! -f "$TOKEN" ]; then
    echo "No token at $TOKEN" >&2
    exit 1
fi

echo "Importing the token for $EMAIL on $HOST..."
"${SSH[@]}" "$HOST" "docker exec -i kibbl-app node health-import.js '$EMAIL'" < "$TOKEN"
