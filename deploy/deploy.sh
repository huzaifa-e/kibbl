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

# The image is built on the host: each build takes a few minutes of CPU, 1-2 GB of memory and
# leaves build cache behind. A host short of disk is refused before anything is built, and
# after the build only our old images and cache older than a day are removed.
MIN_FREE_GB="${MIN_FREE_GB:-3}"
FREE_GB="$("${SSH[@]}" "$HOST" "df -BG --output=avail \"\$(docker info -f '{{.DockerRootDir}}')\" | tail -1 | tr -dc 0-9")"
if [ "${FREE_GB:-0}" -lt "$MIN_FREE_GB" ]; then
    echo "Only ${FREE_GB:-?} GB free for docker on $HOST (at least $MIN_FREE_GB needed): not deploying."
    echo "See what uses it: ssh -p $SSH_PORT $HOST docker system df"
    exit 1
fi

# Apple's git when the one first on the PATH does not run (an Intel build on an arm Mac)
GIT=git
git --version > /dev/null 2>&1 || GIT=/usr/bin/git

# every deploy is a new version: the last number of shared/version.ts goes up by one, the
# change is committed and pushed, the pages and the server show it
VERSION_FILE="$ROOT/shared/version.ts"
CURRENT="$(sed -n "s/.*'v\([0-9]*\.[0-9]*\.[0-9]*\)'.*/\1/p" "$VERSION_FILE")"
NEXT="${CURRENT%.*}.$(( ${CURRENT##*.} + 1 ))"
sed -i '' "s/'v$CURRENT'/'v$NEXT'/" "$VERSION_FILE"
"$GIT" -C "$ROOT" commit -q -m "version v$NEXT" -- shared/version.ts
"$GIT" -C "$ROOT" push -q || echo "v$NEXT committed but not pushed"
echo "Deploying v$NEXT"

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
    --exclude '.feeder-bridge.json' \
    "$ROOT/" "$HOST:$REMOTE_DIR/"

"${SSH[@]}" "$HOST" bash -s -- "$REMOTE_DIR" <<'EOF'
set -euo pipefail
cd "$1"
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
# only our images (label in the Dockerfile): the other projects on the host keep theirs
docker image prune -f --filter label=org.kibbl.app > /dev/null
# build cache, of any project: a cache only, the next build of each takes a little longer
docker builder prune -f --filter until=24h > /dev/null
docker compose ps
echo "Disk for docker: $(df -h --output=avail "$(docker info -f '{{.DockerRootDir}}')" | tail -1 | tr -d ' ') free"
docker system df
EOF
