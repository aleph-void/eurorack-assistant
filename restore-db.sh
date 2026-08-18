#!/usr/bin/env bash
# Restores a dump made by ./backup-db.sh into the deployment's PostgreSQL
# database, REPLACING its current contents. The dump file lives on the HOST;
# it is streamed into pg_restore inside the db container through docker exec.
# Run from the docker host with the stack up.
#
# --files <zip-file> additionally restores the file volumes — manuals,
# panels, captures — from a zip made by ./backup-db.sh --files. Files in the
# archive overwrite files on disk; extra files already on disk are left alone
# (the stores are content-addressed, so they are unreferenced, not wrong).
#
# Usage: ./restore-db.sh [--files <zip-file>] <dump-file>
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  echo "usage: $0 [--files <zip-file>] <dump-file>" >&2
  exit 1
}

FILES_ZIP=""
DUMP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --files)
      [ $# -ge 2 ] || usage
      FILES_ZIP="$2"
      shift
      ;;
    -*) usage ;;
    *)
      [ -z "$DUMP" ] || usage
      DUMP="$1"
      ;;
  esac
  shift
done
[ -n "$DUMP" ] || usage
if [ ! -f "$DUMP" ]; then
  echo "error: no such file: ${DUMP}" >&2
  exit 1
fi
if [ -n "$FILES_ZIP" ] && [ ! -f "$FILES_ZIP" ]; then
  echo "error: no such file: ${FILES_ZIP}" >&2
  exit 1
fi

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
  else
    echo "error: cannot talk to the docker daemon (is it running?)" >&2
    exit 1
  fi
fi

# This throws the current database away. Ask first when a human is present;
# a non-interactive caller (cron, a runbook) has already decided.
if [ -t 0 ]; then
  read -r -p "Replace the current database with ${DUMP}${FILES_ZIP:+ (and restore files from ${FILES_ZIP})}? [y/N] " answer
  case "$answer" in
    y | Y | yes | YES) ;;
    *)
      echo "aborted"
      exit 1
      ;;
  esac
fi

# Stop the app while the schema is dropped and recreated underneath it: the
# server holds connections whose locks would block the drops, and a worker
# mid-job would write into a half-restored database.
$DOCKER compose stop nginx server

# --clean --if-exists drops each object before recreating it, so the restore
# lands on a database that already has the schema; --no-owner because the
# only role is the one doing the restoring.
$DOCKER compose exec -T db pg_restore -U eurorack -d eurorack \
  --clean --if-exists --no-owner --exit-on-error < "$DUMP"
echo "database restored from ${DUMP}"

# The file volumes, while the app is still stopped — the restored database
# references these files by hash.
if [ -n "$FILES_ZIP" ]; then
  $DOCKER compose run --rm --no-deps -T server node scripts/load-data.js < "$FILES_ZIP"
  echo "file volumes restored from ${FILES_ZIP}"
fi

$DOCKER compose up -d nginx server
