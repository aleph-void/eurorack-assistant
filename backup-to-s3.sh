#!/usr/bin/env bash
# Makes a FULL backup of the deployment, uploads it to S3 as one object, and
# deletes all but the newest BACKUP_KEEP backups there. This is what the
# daily timer runs (./install-backup.sh installs it); run it by hand for a
# backup right now.
#
# A full backup is everything a restore needs and nothing a restore can
# rebuild, in one tar named eurorack-backup-<UTC stamp>.tar:
#
#   db.dump         the database (pg_dump custom format, from ./backup-db.sh)
#   files.zip       the file volumes — manuals, panels, captures and the audio
#                   recordings under them (./backup-db.sh --files)
#   llm-token.key   the key that decrypts the LLM credentials stored in the
#                   dump; without it every restored user re-authorizes
#   MANIFEST        when, from where, and the sha256 of each of the above
#
# The llm volume (per-user CLI home directories) is NOT in it: the server
# materializes those from the database and the key. Exports are not either
# (each is a one-shot download, deleted once served).
#
# To restore: fetch the tar, extract it, then
#   ./restore-db.sh --files files.zip db.dump
#   docker compose cp llm-token.key server:/data/keys/llm-token.key
#   docker compose restart server
#
# Configuration is read from .env beside this script (an environment variable
# already set wins over the file):
#
#   BACKUP_S3_BUCKET        required — the bucket name
#   BACKUP_S3_PREFIX        folder in the bucket (default: eurorack-assistant)
#   BACKUP_KEEP             backups to keep, newest first (default: 10;
#                           0 keeps everything)
#   BACKUP_TMP              where the dump and zip are staged before upload
#                           (default: /var/tmp) — needs room for both
#   BACKUP_S3_ENDPOINT_URL  for an S3-compatible store that is not AWS
#   BACKUP_S3_STORAGE_CLASS e.g. STANDARD_IA
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION,
#   AWS_DEFAULT_REGION, AWS_PROFILE — passed to the AWS CLI; leave them out
#                           to use an instance role or the caller's ~/.aws
#
# The AWS CLI is used from PATH when installed, else through the
# amazon/aws-cli container image (BACKUP_AWSCLI_IMAGE), so a host that has
# docker needs nothing else. Pruning only ever touches objects named like
# this script's own uploads, under the prefix, and only once the upload just
# made is seen in the listing — a listing that cannot be read deletes nothing.
#
# Usage: ./backup-to-s3.sh [--no-prune]
set -euo pipefail
cd "$(dirname "$0")"
APP_DIR="$PWD"

PRUNE=1
for arg in "$@"; do
  case "$arg" in
    --no-prune) PRUNE=0 ;;
    *)
      echo "usage: $0 [--no-prune]" >&2
      exit 1
      ;;
  esac
done

log() { echo "[backup] $*" >&2; }
die() {
  echo "[backup] ERROR: $*" >&2
  exit 1
}

# ------------------------------------------------------------ configuration ----
# Only the keys named here are read from .env, and only when the environment
# does not already carry them: the file is KEY=value lines written by
# setup.sh and edited by hand, never a shell script to source.
ENV_KEYS=(
  BACKUP_S3_BUCKET BACKUP_S3_PREFIX BACKUP_KEEP BACKUP_TMP
  BACKUP_S3_ENDPOINT_URL BACKUP_S3_STORAGE_CLASS BACKUP_AWSCLI_IMAGE
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  AWS_REGION AWS_DEFAULT_REGION AWS_PROFILE
)
if [ -f .env ]; then
  for key in "${ENV_KEYS[@]}"; do
    if [ -z "${!key:-}" ]; then
      val=$(grep -E "^${key}=" .env | head -n 1 | cut -d= -f2- || true)
      if [ -n "$val" ]; then
        export "$key=$val"
      fi
    fi
  done
fi

BUCKET="${BACKUP_S3_BUCKET:-}"
[ -n "$BUCKET" ] || die "BACKUP_S3_BUCKET is not set (in .env or the environment); run ./install-backup.sh <bucket>"
PREFIX="${BACKUP_S3_PREFIX:-eurorack-assistant}"
PREFIX="${PREFIX#/}"
PREFIX="${PREFIX%/}"
KEEP="${BACKUP_KEEP:-10}"
[[ "$KEEP" =~ ^[0-9]+$ ]] || die "BACKUP_KEEP must be a whole number, got '${KEEP}'"
TMP="${BACKUP_TMP:-/var/tmp}"
[ -d "$TMP" ] && [ -w "$TMP" ] || die "BACKUP_TMP=${TMP} is not a writable directory"
AWSCLI_IMAGE="${BACKUP_AWSCLI_IMAGE:-amazon/aws-cli}"

DEST_DIR="s3://${BUCKET}${PREFIX:+/${PREFIX}}"
STAMP=$(date -u +%Y%m%d-%H%M%SZ)
NAME="eurorack-backup-${STAMP}.tar"
# What a backup of ours is called: the prune step deletes nothing else.
NAME_PATTERN='^eurorack-backup-[0-9]{8}-[0-9]{6}Z\.tar$'

# ------------------------------------------------------------------ docker ----
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
  else
    die "cannot talk to the docker daemon (is it running?)"
  fi
fi

# ---------------------------------------------------------------- aws cli ----
AWS_ARGS=()
[ -n "${BACKUP_S3_ENDPOINT_URL:-}" ] && AWS_ARGS+=(--endpoint-url "$BACKUP_S3_ENDPOINT_URL")

if command -v aws >/dev/null 2>&1; then
  aws_cli() { aws "${AWS_ARGS[@]}" "$@"; }
  AWS_HOW="aws CLI at $(command -v aws)"
else
  # No CLI on the host: run it from its image. The host network is what lets
  # an instance role work from inside the container (IMDSv2's hop limit of
  # one stops a bridged container short of the metadata service), and the
  # caller's ~/.aws is handed in read-only so a profile works too.
  AWSCLI_DOCKER=(run --rm -i --network host)
  for key in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION AWS_DEFAULT_REGION AWS_PROFILE; do
    [ -n "${!key:-}" ] && AWSCLI_DOCKER+=(-e "$key")
  done
  if [ -d "${HOME:-/nonexistent}/.aws" ]; then
    AWSCLI_DOCKER+=(-v "${HOME}/.aws:/root/.aws:ro")
  fi
  aws_cli() { $DOCKER "${AWSCLI_DOCKER[@]}" "$AWSCLI_IMAGE" "${AWS_ARGS[@]}" "$@"; }
  AWS_HOW="${AWSCLI_IMAGE} container (no aws CLI on PATH)"
fi

# ---------------------------------------------------------------- staging ----
# One backup at a time: a second run while the first is still uploading would
# dump the database again for nothing and race the prune.
LOCK="${TMP}/eurorack-backup.lock"
exec 9>"$LOCK"
flock -n 9 || die "another backup is already running (${LOCK})"

STAGE=$(mktemp -d "${TMP}/eurorack-backup.XXXXXX")
chmod 700 "$STAGE"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

log "staging in ${STAGE}; uploading with ${AWS_HOW}"

# The database and the file volumes, through the same script a hand backup
# uses, so the two never drift apart.
./backup-db.sh --files "${STAGE}/db.dump"
mv "${STAGE}/db-files.zip" "${STAGE}/files.zip"

# The key sits in the llmkeys volume, created the first time a user connects
# an LLM account — a deployment where nobody has yet has no key to back up,
# and the manifest says so.
KEY_FILE=/data/keys/llm-token.key
MEMBERS=(db.dump files.zip)
if $DOCKER compose exec -T server test -f "$KEY_FILE" 2>/dev/null; then
  $DOCKER compose exec -T server cat "$KEY_FILE" > "${STAGE}/llm-token.key"
  chmod 600 "${STAGE}/llm-token.key"
  MEMBERS+=(llm-token.key)
  KEY_NOTE="included"
else
  KEY_NOTE="not present on the server (no LLM account connected yet)"
fi

{
  echo "eurorack-assistant full backup"
  echo "name: ${NAME}"
  echo "made: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host: $(hostname 2>/dev/null || echo unknown)"
  echo "app_dir: ${APP_DIR}"
  echo "revision: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "llm-token.key: ${KEY_NOTE}"
  echo
  echo "restore:"
  echo "  ./restore-db.sh --files files.zip db.dump"
  echo "  docker compose cp llm-token.key server:${KEY_FILE}"
  echo "  docker compose restart server"
  echo
  (cd "$STAGE" && sha256sum "${MEMBERS[@]}")
} > "${STAGE}/MANIFEST"
MEMBERS+=(MANIFEST)

# ----------------------------------------------------------------- upload ----
# tar straight into the upload: the dump and the zip are the only copies on
# disk, and a multi-gigabyte archive never lands beside them. The size is a
# hint for the multipart chunking, which is what lets a stream this long go.
SIZE=0
for member in "${MEMBERS[@]}"; do
  SIZE=$((SIZE + $(stat -c %s "${STAGE}/${member}") + 1024))
done
UPLOAD_ARGS=(--expected-size "$SIZE")
[ -n "${BACKUP_S3_STORAGE_CLASS:-}" ] && UPLOAD_ARGS+=(--storage-class "$BACKUP_S3_STORAGE_CLASS")

log "uploading ${NAME} (about $((SIZE / 1024 / 1024)) MB) to ${DEST_DIR}/"
tar -cf - -C "$STAGE" "${MEMBERS[@]}" | aws_cli s3 cp - "${DEST_DIR}/${NAME}" "${UPLOAD_ARGS[@]}"
log "uploaded ${DEST_DIR}/${NAME}"

# ------------------------------------------------------------------ prune ----
if [ "$PRUNE" = "0" ] || [ "$KEEP" = "0" ]; then
  log "keeping every backup (prune off)"
  exit 0
fi

# The listing is the only thing the prune trusts, and only when the upload
# just made is in it: a listing that failed, or that somehow misses the
# newest backup, is not one to delete older backups on the strength of.
if ! LISTING=$(aws_cli s3 ls "${DEST_DIR}/"); then
  log "WARNING: could not list ${DEST_DIR}/ — nothing pruned"
  exit 0
fi
# `aws s3 ls` prints "<date> <time> <size> <name>" per object.
BACKUPS=$(echo "$LISTING" | awk '{ print $4 }' | grep -E "$NAME_PATTERN" | sort || true)
if ! echo "$BACKUPS" | grep -qxF "$NAME"; then
  log "WARNING: ${NAME} is not in the listing of ${DEST_DIR}/ — nothing pruned"
  exit 0
fi

TOTAL=$(echo "$BACKUPS" | grep -c .)
if [ "$TOTAL" -le "$KEEP" ]; then
  log "${TOTAL} backup(s) kept (limit ${KEEP}); nothing to prune"
  exit 0
fi
# Names sort by their UTC stamp, so the oldest come first.
OLD=$(echo "$BACKUPS" | head -n "$((TOTAL - KEEP))")
while IFS= read -r old; do
  [ -n "$old" ] || continue
  aws_cli s3 rm "${DEST_DIR}/${old}"
done <<< "$OLD"
log "pruned $((TOTAL - KEEP)) old backup(s); ${KEEP} kept"
