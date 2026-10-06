#!/bin/bash
# Renews the Google Health access of a kibbl. user. While the Google OAuth app is in
# testing mode, Google ends a token after 7 days: this asks for a new consent in the
# browser (whoofit's gh_auth.py, its OAuth client and localhost redirect) and imports
# the new token on the server. The token goes through ssh stdin only, never an argument.
#
#   ./deploy/renew-health-token.sh user@example.com
#   HOST=jh@100.84.217.119 SSH_PORT=4711 ./deploy/renew-health-token.sh user@example.com
#   ./deploy/renew-health-token.sh --import-only user@example.com    the current token, no consent
#   ./deploy/renew-health-token.sh --when-expiring 48 user@example.com
#       only when the token ends within 48 hours (what the daily job runs, deploy/install-health-renewal.sh)
#   ./deploy/renew-health-token.sh --check user@example.com          says when the token ends, changes nothing
#
# WHOOFIT_DIR: the whoofit checkout with its .env and .venv (default: next to this repository)

set -euo pipefail

HOST="${HOST:-jhubuntu}"
SSH=(ssh ${SSH_PORT:+-p "$SSH_PORT"} -o ConnectTimeout=20)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHOOFIT_DIR="${WHOOFIT_DIR:-$ROOT/../whoofit}"
CONSENT_WAIT_S=$((2 * 3600)) # an unanswered consent is given up after this; the next run asks again

mode=renew
within_hours=""
while [ $# -gt 1 ]; do
    case "$1" in
        --import-only) mode=import ;;
        --check) mode=check ;;
        --when-expiring) within_hours="$2"; shift ;;
        *) break ;;
    esac
    shift
done
EMAIL="${1:-}"
if [ -z "$EMAIL" ]; then
    echo "usage: $0 [--import-only | --check | --when-expiring HOURS] <kibbl user e-mail>" >&2
    exit 1
fi
TOKEN="$WHOOFIT_DIR/gh_token.json"
# a hash of the refresh token last imported: a token that was renewed but not imported
# (server unreachable) is imported on the next run, without a new consent
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/kibbl"
IMPORTED="$STATE_DIR/health-imported-$(echo -n "$HOST $EMAIL" | shasum -a 256 | cut -c1-12)"
token_hash() { jq -r '.refresh_token // empty' "$TOKEN" 2>/dev/null | shasum -a 256 | cut -c1-64; }

notify() {
    # a notification when run by launchd, where nobody reads the output
    osascript -e "display notification \"$1\" with title \"kibbl. health\"" 2>/dev/null || true
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1"
}

# seconds until the refresh token ends; empty when it does not end (a published app)
seconds_left() {
    [ -f "$TOKEN" ] || return 0
    jq -r 'if .refresh_token_expires_in then (.obtained_at + .refresh_token_expires_in - now | floor) else empty end' "$TOKEN"
}

if [ -n "$within_hours" ] && [ -f "$TOKEN" ] && [ "$(token_hash)" != "$(cat "$IMPORTED" 2>/dev/null)" ]; then
    mode=import # renewed earlier, not on the server yet
elif [ "$mode" = check ] || [ -n "$within_hours" ]; then
    left=$(seconds_left)
    if [ -z "$left" ]; then
        echo "The token does not expire (or there is none at $TOKEN)."
        [ "$mode" = check ] && exit 0
        [ -f "$TOKEN" ] && exit 0
    else
        echo "The token ends in $((left / 3600)) h $(((left % 3600) / 60)) min."
        [ "$mode" = check ] && exit 0
        if [ "$left" -gt $((within_hours * 3600)) ]; then
            exit 0 # not due yet
        fi
    fi
fi

if [ "$mode" != import ]; then
    if [ ! -x "$WHOOFIT_DIR/.venv/bin/python" ] || [ ! -f "$WHOOFIT_DIR/gh_auth.py" ]; then
        notify "whoofit not found at $WHOOFIT_DIR, the access was not renewed"
        exit 1
    fi
    before=$(stat -f %m "$TOKEN" 2>/dev/null || echo 0)
    notify "Renew the Google Health access: confirm it in the browser"
    # gh_auth.py reads the OAuth client from whoofit's .env in its own folder and waits
    # for the browser; it is stopped when nobody answers
    (cd "$WHOOFIT_DIR" && exec .venv/bin/python gh_auth.py) &
    auth=$!
    waited=0
    while kill -0 "$auth" 2>/dev/null && [ "$waited" -lt "$CONSENT_WAIT_S" ]; do
        sleep 5
        waited=$((waited + 5))
    done
    if kill -0 "$auth" 2>/dev/null; then
        kill "$auth" 2>/dev/null || true
        notify "The consent was not given within 2 hours, asking again on the next run"
        exit 1
    fi
    wait "$auth" || true
    after=$(stat -f %m "$TOKEN" 2>/dev/null || echo 0)
    if [ "$after" = "$before" ]; then
        notify "No new token was written, nothing imported"
        exit 1
    fi
fi

if [ ! -f "$TOKEN" ]; then
    notify "No token at $TOKEN"
    exit 1
fi

echo "Importing the token for $EMAIL on $HOST..."
if result=$("${SSH[@]}" "$HOST" "docker exec -i kibbl-app node health-import.js '$EMAIL'" < "$TOKEN" 2>&1); then
    echo "$result" | grep -v "MongoDB" || true
    mkdir -p "$STATE_DIR"
    token_hash > "$IMPORTED"
    notify "Google Health access renewed on the server"
else
    echo "$result" >&2
    notify "The new token could not be imported on the server (is it reachable?). Run the script again by hand."
    exit 1
fi
