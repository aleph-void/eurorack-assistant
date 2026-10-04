#!/usr/bin/env bash
# Takes a FULL backup of the deployment and uploads it to S3, keeping the
# newest BACKUP_KEEP runs (10 by default) and deleting the rest. This is what
# the eurorack-backup.timer systemd unit runs once a day; it can also be run
# by hand from the docker host with the stack up.
#
# One run is one prefix in the bucket, named by its UTC timestamp:
#
#   s3://<bucket>/<prefix>/<YYYYmmdd-HHMMSS>/db.dump      pg_dump, custom format
#                                           /files.zip    manuals, panels, captures
#                                           /llm.tar      the token encryption key
#                                                         (/data/keys) and the
#                                                         per-user CLI homes
#                                                         (/data/llm)
#                                           /manifest.txt written LAST — a run
#                                                         without one did not
#                                                         finish
#
# The pieces are the same ones ./backup-db.sh --files makes, but STREAMED
# straight from the containers into the bucket, so a backup needs no free disk
# on the host however large the file volumes have grown. Restoring one is
# downloading the run and handing it to ./restore-db.sh:
#
#   aws s3 cp --recursive s3://<bucket>/<prefix>/<run>/ ./restore/
#   ./restore-db.sh --files restore/files.zip --llm restore/llm.tar restore/db.dump
#
# llm.tar is in the backup because a dump alone cannot use the LLM tokens it
# holds (they are encrypted with the key in /data/keys), and it is why the
# bucket MUST be private: a run is everything needed to stand the instance up
# again, credentials included. Objects are uploaded with server-side
# encryption (SSE-S3) asked for explicitly.
#
# Configuration is read from .env beside this script (where setup.sh keeps
# the rest of the deployment's settings):
#
#   BACKUP_S3_BUCKET        required — the bucket name (no s3:// prefix)
#   BACKUP_S3_PREFIX        folder inside it (default: eurorack-assistant)
#   BACKUP_KEEP             runs to keep (default: 10)
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN,
#   AWS_DEFAULT_REGION, AWS_ENDPOINT_URL, AWS_PROFILE
#                           passed to the AWS CLI when set; when they are
#                           not, the CLI's own chain applies (~/.aws, an
#                           instance role), so an EC2 host with a role on it
#                           needs none of them. AWS_ENDPOINT_URL is how an
#                           S3-compatible store (MinIO, R2, B2) is named.
#
# The upload uses the `aws` CLI on the host when there is one, else the
# amazon/aws-cli docker image — docker is the one thing a host running this
# app is sure to have.
#
# Usage: ./backup-s3.sh [--dry-run]
#   --dry-run  shows what would be uploaded and pruned without touching S3
set -euo pipefail
cd "$(dirname "$0")"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "usage: $0 [--dry-run]" >&2
      exit 1
      ;;
  esac
done

log() { echo "[backup] $*"; }
fail() {
  echo "[backup] ERROR: $*" >&2
  exit 1
}

# ------------------------------------------------------------- settings ----
# .env is read key by key rather than sourced: it is a file setup.sh writes,
# but one line of it being a shell command is still one line too many.
get_env() { grep -E "^$1=" .env 2>/dev/null | head -n 1 | cut -d= -f2- || true; }

[ -f .env ] || fail "no .env here — run ./setup.sh first"

BUCKET=$(get_env BACKUP_S3_BUCKET)
[ -n "$BUCKET" ] || fail "BACKUP_S3_BUCKET is not set in .env (see README: Backups to S3)"
case "$BUCKET" in
  s3://*) fail "BACKUP_S3_BUCKET is the bucket name alone, without s3://" ;;
esac

PREFIX=$(get_env BACKUP_S3_PREFIX)
PREFIX="${PREFIX:-eurorack-assistant}"
PREFIX="${PREFIX#/}"
PREFIX="${PREFIX%/}"
[ -n "$PREFIX" ] || fail "BACKUP_S3_PREFIX must not be empty (every run is a folder under it)"

KEEP=$(get_env BACKUP_KEEP)
KEEP="${KEEP:-10}"
case "$KEEP" in
  '' | *[!0-9]*) fail "BACKUP_KEEP must be a whole number (got '${KEEP}')" ;;
esac
[ "$KEEP" -ge 1 ] || fail "BACKUP_KEEP must be at least 1"

# The AWS variables go to the CLI through the environment, whichever way it
# runs. A variable already exported wins over .env, so an operator can try a
# different key or endpoint for one run without editing the file.
for var in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
  AWS_DEFAULT_REGION AWS_ENDPOINT_URL AWS_PROFILE; do
  if [ -z "${!var:-}" ]; then
    value=$(get_env "$var")
    if [ -n "$value" ]; then export "$var=$value"; fi
  fi
done

BASE="s3://${BUCKET}/${PREFIX}"

# --------------------------------------------------------------- docker ----
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
  else
    fail "cannot talk to the docker daemon (is it running?)"
  fi
fi

# ------------------------------------------------------------- aws cli ----
# A single `aws` that is either the host's CLI or the official image. The
# image gets the host network so an instance role's metadata service is one
# hop away, the credential variables, and ~/.aws read-only when there is one.
AWS_IMAGE="amazon/aws-cli:2"
if command -v aws >/dev/null 2>&1; then
  aws() { command aws "$@"; }
  log "using $(command -v aws)"
else
  AWS_DOCKER_ARGS=(run --rm -i --network host)
  for var in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
    AWS_DEFAULT_REGION AWS_ENDPOINT_URL AWS_PROFILE; do
    AWS_DOCKER_ARGS+=(-e "$var")
  done
  if [ -d "${HOME:-/root}/.aws" ]; then
    AWS_DOCKER_ARGS+=(-v "${HOME:-/root}/.aws:/root/.aws:ro")
  fi
  aws() { $DOCKER "${AWS_DOCKER_ARGS[@]}" "$AWS_IMAGE" "$@"; }
  log "no aws CLI on the host; using the $AWS_IMAGE image"
fi

# -------------------------------------------------------------- the run ----
# One backup at a time: the timer and a hand-run must not interleave, and a
# night where the previous run is still uploading is a night to skip, not
# to double.
LOCK_DIR=/run/lock
[ -w "$LOCK_DIR" ] || LOCK_DIR="${TMPDIR:-/tmp}"
exec 9>"${LOCK_DIR}/eurorack-backup.lock"
if ! flock -n 9; then
  fail "another backup is running (${LOCK_DIR}/eurorack-backup.lock is held)"
fi

RUN=$(date -u +%Y%m%d-%H%M%S)
RUN_URL="${BASE}/${RUN}"
COMPLETE=0

# A run that dies half way leaves no half-run behind: whatever it managed to
# upload is removed, so the bucket holds finished runs and nothing else. (A
# host that loses power mid-run cannot run this; the pruning below sweeps
# such a run up the next night, because it never got its manifest.)
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$COMPLETE" = "0" ] && [ "$DRY_RUN" = "0" ]; then
    echo "[backup] failed; removing the partial run ${RUN_URL}/" >&2
    aws s3 rm --recursive --quiet "${RUN_URL}/" || true
  fi
  exit "$status"
}
trap cleanup EXIT

# Streams stdin into one object of this run. `aws s3 cp -` uploads a stream in
# multipart; with the CLI's default part size that caps one object at 80 GB,
# which is far beyond any volume this app has grown — if yours gets there,
# `aws configure set default.s3.multipart_chunksize 64MB` raises it.
upload() {
  local name="$1"
  if [ "$DRY_RUN" = "1" ]; then
    local bytes
    bytes=$(wc -c | tr -d ' ')
    log "would upload ${name} (${bytes} bytes)"
    return 0
  fi
  aws s3 cp --only-show-errors --sse AES256 - "${RUN_URL}/${name}"
}

log "backing up to ${RUN_URL}/"

# The database: pg_dump in the db container, its custom (compressed, selectively
# restorable) format, streamed out through docker exec. -T keeps docker from
# allocating a TTY that would mangle the binary stream. pipefail makes a
# pg_dump failure the run's failure rather than an empty object's success.
$DOCKER compose exec -T db pg_dump -U eurorack -d eurorack --format=custom | upload db.dump
log "uploaded db.dump"

# The file volumes — manuals, panels, captures (which hold the audio
# recordings too) — as the zip scripts/load-data.js takes back. Exports and
# videos are left out on purpose: both hold work files that are deleted once
# served or analysed.
$DOCKER compose exec -T server node scripts/dump-data.js | upload files.zip
log "uploaded files.zip"

# The token encryption key and the per-user CLI homes, as a tar of /data's
# `keys` and `llm` directories (the paths ./restore-db.sh --llm puts back).
# A fresh container rather than exec: the volumes are what matter, and this
# works whether or not the server happens to be up. --ignore-failed-read
# because a credential file an agent run created unreadable to the server
# user is a file to skip, not a reason to have no backup of the key.
$DOCKER compose run --rm --no-deps -T server \
  tar -C /data -cf - --ignore-failed-read keys llm | upload llm.tar
log "uploaded llm.tar"

# The manifest goes last, so its presence is what says the run is whole.
{
  echo "eurorack-assistant backup"
  echo "run: ${RUN}"
  echo "taken: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host: $(hostname)"
  if command -v git >/dev/null 2>&1 && git rev-parse --short HEAD >/dev/null 2>&1; then
    echo "revision: $(git rev-parse --short HEAD)"
  fi
  echo "objects: db.dump files.zip llm.tar"
  echo "restore: ./restore-db.sh --files files.zip --llm llm.tar db.dump"
} | upload manifest.txt
log "uploaded manifest.txt"
COMPLETE=1

if [ "$DRY_RUN" = "0" ]; then
  log "run ${RUN} complete:"
  aws s3 ls "${RUN_URL}/" | sed 's/^/[backup]   /'
fi

# ---------------------------------------------------------------- prune ----
# Keep the newest KEEP finished runs. Counting runs rather than days means a
# week of failed nights leaves ten good backups in the bucket instead of
# three; an unfinished run (no manifest) older than this one is a leftover
# and goes whatever its age.
# This run is counted in by hand rather than read back off the listing, so
# a dry run (which uploaded nothing) prunes exactly as a real one would.
runs=$(
  {
    aws s3 ls "${BASE}/" | awk '$1 == "PRE" { print $2 }' | sed 's,/$,,' \
      | grep -E '^[0-9]{8}-[0-9]{6}$' || true
    echo "$RUN"
  } | sort -u
)

complete=()
for run in $runs; do
  if [ "$run" = "$RUN" ]; then
    complete+=("$run")
  elif aws s3 ls "${BASE}/${run}/manifest.txt" >/dev/null 2>&1; then
    complete+=("$run")
  elif [ "$DRY_RUN" = "1" ]; then
    log "would delete unfinished run ${run}"
  else
    log "deleting unfinished run ${run}"
    aws s3 rm --recursive --quiet "${BASE}/${run}/"
  fi
done

excess=$(( ${#complete[@]} - KEEP ))
if [ "$excess" -gt 0 ]; then
  for run in "${complete[@]:0:$excess}"; do
    if [ "$DRY_RUN" = "1" ]; then
      log "would delete run ${run} (keeping the newest ${KEEP})"
    else
      log "deleting run ${run} (keeping the newest ${KEEP})"
      aws s3 rm --recursive --quiet "${BASE}/${run}/"
    fi
  done
fi

log "done — ${#complete[@]} run(s) in ${BASE}/, keeping up to ${KEEP}"
