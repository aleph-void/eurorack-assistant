#!/usr/bin/env bash
# Resets the admin account's password to a new random hex string, printed
# once to the terminal. The admin is logged out everywhere and must set a
# new password at their next login. Run from the docker host.
set -euo pipefail
cd "$(dirname "$0")"

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
  else
    echo "error: cannot talk to the docker daemon (is it running?)" >&2
    exit 1
  fi
fi

$DOCKER compose run --rm --no-deps server node scripts/create-admin.js --reset
