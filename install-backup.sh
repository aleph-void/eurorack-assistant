#!/usr/bin/env bash
# Installs the daily backup: records the S3 settings in .env and puts the
# systemd timer in place that runs ./backup-to-s3.sh once a day (requires
# sudo for the unit files). Re-run it to change a setting; run it with no
# arguments to re-render the units from what .env already says, which is
# what ./setup.sh does on every run once a bucket is configured.
#
#   Usage: ./install-backup.sh [options] [s3-bucket]
#
#   --prefix <folder>   folder in the bucket             (default: eurorack-assistant)
#   --keep <n>          backups to keep, newest first    (default: 10)
#   --at <HH:MM>        time of day, host local time     (default: 03:17)
#   --region <region>   AWS region, written to .env as AWS_REGION
#   --now               make the first backup right away, through the unit
#
# Credentials are not taken here. Give the host an instance role, configure a
# profile for root (`sudo aws configure`), or put AWS_ACCESS_KEY_ID and
# AWS_SECRET_ACCESS_KEY in .env beside the bucket. See backup-to-s3.sh for
# every setting the job reads.
set -euo pipefail
cd "$(dirname "$0")"

info() { echo "[backup] $*"; }
warn() { echo "[backup] WARNING: $*" >&2; }
usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 1
}

BUCKET=""
PREFIX=""
KEEP=""
AT=""
REGION=""
NOW=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix | --keep | --at | --region)
      [ $# -ge 2 ] || usage
      case "$1" in
        --prefix) PREFIX="$2" ;;
        --keep) KEEP="$2" ;;
        --at) AT="$2" ;;
        --region) REGION="$2" ;;
      esac
      shift
      ;;
    --now) NOW=1 ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      [ -z "$BUCKET" ] || usage
      BUCKET="$1"
      ;;
  esac
  shift
done

[ -f .env ] || {
  echo "ERROR: no .env here — run ./setup.sh first" >&2
  exit 1
}

set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    echo "${key}=${val}" >> .env
  fi
}
get_env() { grep -E "^$1=" .env 2>/dev/null | head -n 1 | cut -d= -f2- || true; }

# ------------------------------------------------------------- settings ----
if [ -n "$BUCKET" ]; then
  [[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || {
    echo "ERROR: '${BUCKET}' is not a bucket name (lowercase letters, digits, dots and dashes)" >&2
    exit 1
  }
  set_env BACKUP_S3_BUCKET "$BUCKET"
fi
BUCKET=$(get_env BACKUP_S3_BUCKET)
[ -n "$BUCKET" ] || {
  echo "ERROR: no bucket: pass one, e.g. ./install-backup.sh my-backups" >&2
  exit 1
}
if [ -n "$PREFIX" ]; then set_env BACKUP_S3_PREFIX "$PREFIX"; fi
if [ -n "$KEEP" ]; then
  [[ "$KEEP" =~ ^[0-9]+$ ]] || {
    echo "ERROR: --keep takes a whole number" >&2
    exit 1
  }
  set_env BACKUP_KEEP "$KEEP"
fi
if [ -n "$AT" ]; then
  [[ "$AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || {
    echo "ERROR: --at takes a time as HH:MM (24h)" >&2
    exit 1
  }
  set_env BACKUP_TIME "$AT"
fi
if [ -n "$REGION" ]; then set_env AWS_REGION "$REGION"; fi

BACKUP_TIME=$(get_env BACKUP_TIME)
BACKUP_TIME="${BACKUP_TIME:-03:17}"
[[ "$BACKUP_TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || {
  echo "ERROR: BACKUP_TIME in .env must be HH:MM, got '${BACKUP_TIME}'" >&2
  exit 1
}
KEEP=$(get_env BACKUP_KEEP)
PREFIX=$(get_env BACKUP_S3_PREFIX)
info "bucket s3://${BUCKET}/${PREFIX:-eurorack-assistant}/, keeping the newest ${KEEP:-10}, daily at ${BACKUP_TIME}"

# The .env now names where every backup goes and may name the credentials
# that get it there; keep it to its owner.
chmod 600 .env 2>/dev/null || true

# ---------------------------------------------------------------- units ----
SERVICE="eurorack-assistant-backup.service"
TIMER="eurorack-assistant-backup.timer"
CRON_LINE="$(echo "$BACKUP_TIME" | cut -d: -f2) $(echo "$BACKUP_TIME" | cut -d: -f1 | sed 's/^0//') * * * cd ${PWD} && ./backup-to-s3.sh"

if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  warn "no systemd on this host; schedule the backup with cron instead:"
  warn "  (sudo crontab -l 2>/dev/null; echo '${CRON_LINE}') | sudo crontab -"
  exit 0
fi

DOCKER="docker"
if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
fi
# A root unit drives the ROOT docker daemon; under rootless docker the stack
# belongs to the user's own daemon, which a system unit cannot see.
if $DOCKER info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
  warn "rootless docker: a system-wide timer would drive the wrong daemon."
  warn "Schedule it as a user timer instead:"
  warn "  sudo loginctl enable-linger $USER"
  warn "  mkdir -p ~/.config/systemd/user"
  warn "  sed -e 's|@APP_DIR@|${PWD}|g' deploy/${SERVICE} > ~/.config/systemd/user/${SERVICE}"
  warn "  sed -e 's|@BACKUP_TIME@|${BACKUP_TIME}|g' deploy/${TIMER} > ~/.config/systemd/user/${TIMER}"
  warn "  systemctl --user daemon-reload && systemctl --user enable --now ${TIMER}"
  exit 0
fi

render() {
  local src="$1" dst="$2" rendered
  rendered=$(mktemp)
  sed -e "s|@APP_DIR@|${PWD}|g" -e "s|@BACKUP_TIME@|${BACKUP_TIME}|g" "$src" > "$rendered"
  # /etc/systemd/system is world-readable, so compare without sudo — no
  # password prompt for a unit that has not changed.
  if [ -r "$dst" ] && cmp -s "$rendered" "$dst"; then
    info "$(basename "$dst") already installed and current"
  else
    info "installing $(basename "$dst") (requires sudo)..."
    sudo install -m 644 "$rendered" "$dst"
  fi
  rm -f "$rendered"
}

render "deploy/${SERVICE}" "/etc/systemd/system/${SERVICE}"
render "deploy/${TIMER}" "/etc/systemd/system/${TIMER}"
sudo systemctl daemon-reload
sudo systemctl enable --now "$TIMER" >/dev/null
info "${TIMER} enabled:"
systemctl list-timers "$TIMER" --no-pager || true

if [ "$NOW" = "1" ]; then
  info "making the first backup now (journalctl -u ${SERVICE} -f to follow)..."
  if sudo systemctl start "$SERVICE"; then
    info "first backup done"
  else
    warn "the first backup FAILED; the reason is in: journalctl -u ${SERVICE} -n 50"
    exit 1
  fi
fi
