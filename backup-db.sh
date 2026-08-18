#!/usr/bin/env bash
# Dumps the deployment's PostgreSQL database to a file in /tmp on the HOST.
# pg_dump runs inside the db container, but its output streams through
# docker exec to this shell, so nothing is written inside the container.
# Run from the docker host with the stack up; restore with ./restore-db.sh.
#
# --files additionally zips the file volumes — manuals, panels, captures —
# to a second file beside the dump (the database only references those files
# by hash; without them a restored instance re-downloads what it can and has
# lost the rest).
#
# Usage: ./backup-db.sh [--files] [output-file]
set -euo pipefail
cd "$(dirname "$0")"

FILES=0
OUT=""
for arg in "$@"; do
  case "$arg" in
    --files) FILES=1 ;;
    -*)
      echo "usage: $0 [--files] [output-file]" >&2
      exit 1
      ;;
    *) OUT="$arg" ;;
  esac
done

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
  else
    echo "error: cannot talk to the docker daemon (is it running?)" >&2
    exit 1
  fi
fi

OUT="${OUT:-/tmp/eurorack-db-$(date +%Y%m%d-%H%M%S).dump}"

# Custom format: compressed, and pg_restore can replay it selectively.
# -T keeps docker from allocating a TTY that would mangle the binary stream.
$DOCKER compose exec -T db pg_dump -U eurorack -d eurorack --format=custom > "$OUT"
echo "database dumped to ${OUT}"

if [ "$FILES" = "1" ]; then
  FILES_OUT="${OUT%.dump}-files.zip"
  $DOCKER compose exec -T server node scripts/dump-data.js > "$FILES_OUT"
  echo "file volumes zipped to ${FILES_OUT}"
fi
