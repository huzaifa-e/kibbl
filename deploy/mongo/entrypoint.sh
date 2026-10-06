#!/bin/bash
# The mongo image's own entrypoint (it starts mongod as the mongodb user), with mongod's
# json log lines rewritten into the columns of the server's log by log.jq.
#
# exec keeps mongod the process docker signals, so `docker compose stop` still shuts the
# database down cleanly; jq reads its output through a pipe and ends with it.

exec docker-entrypoint.sh "$@" > >(exec jq -Rr --unbuffered -f "$(dirname "$0")/log.jq") 2>&1
