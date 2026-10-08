#!/bin/bash
# Deploys the server to jhubuntu (or HOST): copies the repository, builds the image
# there and restarts it. The server's .env and data/ are never overwritten. It reaches
# jhubuntu over Tailscale, which works in the office and away from it.
#
#   ./deploy/deploy.sh            first run: creates .env from .env.example and stops
#   HOST=other SSH_PORT=22 ./deploy/deploy.sh
#   HOST=jh@10.0.1.99 ./deploy/deploy.sh                      on the office network, without Tailscale

set -euo pipefail

HOST="${HOST:-jh@100.84.217.119}"
SSH_PORT="${SSH_PORT:-4711}"
REMOTE_DIR="${REMOTE_DIR:-kibbl}"
SSH=(ssh -p "$SSH_PORT" -o ConnectTimeout=20)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# the build shown at the bottom of every page: the commit and the time of this deploy
BUILD="$(git -C "$ROOT" rev-parse --short=7 HEAD) $(date '+%Y-%m-%d %H:%M')"

echo "Copying to $HOST:$REMOTE_DIR"
rsync -az --delete -e "${SSH[*]}" \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude '.turbo/' \
    --exclude 'backend/dist/' \
    --exclude 'firmware/' \
    --exclude 'data/' \
    --exclude '.env' \
    --exclude '.simulated-device.json' \
    "$ROOT/" "$HOST:$REMOTE_DIR/"

"${SSH[@]}" "$HOST" bash -s -- "$REMOTE_DIR" "$BUILD" <<'EOF'
set -euo pipefail
cd "$1"
echo "$2" > .deploy-build
if [ ! -f .env ]; then
    cp .env.example .env
    sed -i "s/^JWT_SECRET=$/JWT_SECRET=$(openssl rand -hex 32)/" .env
    sed -i "s/^MONGO_ROOT_PASSWORD=$/MONGO_ROOT_PASSWORD=$(openssl rand -hex 24)/" .env
    sed -i "s/^MONGO_APP_PASSWORD=$/MONGO_APP_PASSWORD=$(openssl rand -hex 24)/" .env
    echo "Created $1/.env: set ADMIN_EMAIL, ADMIN_PASSWORD and DEVICE_BASE_URL there, then deploy again."
    exit 1
fi
mkdir -p data/app data/mongo
docker compose up -d --build
docker image prune -f > /dev/null
docker compose ps
EOF
