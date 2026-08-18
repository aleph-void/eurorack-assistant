#!/usr/bin/env bash
#
# One-shot setup for Eurorack Assistant.
#
#   Usage: ./setup.sh [fqdn]
#
#   1. Installs Docker (docker.io + docker-compose-v2) on Ubuntu if missing.
#   2. Installs the LLM provider CLIs (claude, codex) if missing.
#   3. When an FQDN is given (or remembered in .env) and Let's Encrypt certs
#      exist in /etc/letsencrypt/live/<fqdn>/, serves HTTPS on port 443 (with
#      port 80 redirecting) instead of plain HTTP on port 8080.
#   4. Generates secrets, builds containers, migrates the database.
#   5. Creates the admin account — its random password is printed ONCE below
#      and stored nowhere else in cleartext.
set -euo pipefail
cd "$(dirname "$0")"

FQDN="${1:-}"

info() { echo "[setup] $*"; }
warn() { echo "[setup] WARNING: $*" >&2; }

INTERACTIVE=0
if [ -t 0 ]; then INTERACTIVE=1; fi

is_ubuntu() {
  [ -f /etc/os-release ] && grep -qiE '^(ID=ubuntu|ID_LIKE=.*ubuntu.*)' /etc/os-release
}

# ---------------------------------------------------------------- docker ----
DOCKER="docker"

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi
  if ! is_ubuntu; then
    echo "ERROR: docker + docker compose v2 are required." >&2
    echo "Automatic installation currently targets Ubuntu; install Docker manually:" >&2
    echo "  https://docs.docker.com/engine/install/" >&2
    exit 1
  fi
  info "installing docker.io and docker-compose-v2 (requires sudo)..."
  sudo apt-get update
  sudo apt-get install -y docker.io docker-compose-v2
  sudo systemctl enable --now docker || true

  if ! docker info >/dev/null 2>&1; then
    if ! id -nG "$USER" | grep -qw docker; then
      info "adding $USER to the docker group (takes effect at next login)..."
      sudo usermod -aG docker "$USER" || true
    fi
    # Fall back to sudo for the rest of this run.
    if sudo docker info >/dev/null 2>&1; then
      warn "using 'sudo docker' for this run; log out and back in to use docker without sudo"
      DOCKER="sudo docker"
    else
      echo "ERROR: docker is installed but not usable, even with sudo." >&2
      exit 1
    fi
  fi
}

# Compose ≥2.34 builds via buildx Bake and warns ("configured to build using
# Bake, but buildx isn't installed") when the plugin is missing — make sure
# it's there.
ensure_buildx() {
  if $DOCKER buildx version >/dev/null 2>&1; then
    return
  fi
  if ! is_ubuntu; then
    warn "docker buildx plugin missing; compose will fall back to the classic builder."
    warn "Install it manually: https://docs.docker.com/build/concepts/overview/#install-buildx"
    return
  fi
  info "installing docker-buildx (requires sudo)..."
  sudo apt-get install -y docker-buildx || {
    sudo apt-get update && sudo apt-get install -y docker-buildx
  } || warn "could not install docker-buildx; compose will fall back to the classic builder."
}

# --------------------------------------------------------------- LLM CLIs ----
ensure_node() {
  if command -v npm >/dev/null 2>&1; then return 0; fi
  if is_ubuntu; then
    info "installing nodejs + npm (required for the LLM CLIs, requires sudo)..."
    sudo apt-get update
    sudo apt-get install -y nodejs npm
  fi
  command -v npm >/dev/null 2>&1
}

install_cli() {
  local bin="$1" pkg="$2"
  if command -v "$bin" >/dev/null 2>&1; then
    info "$bin CLI already installed"
    return 0
  fi
  info "installing $bin CLI ($pkg)..."
  npm install -g "$pkg" 2>/dev/null || sudo npm install -g "$pkg" || {
    warn "could not install $pkg — install it manually with: npm install -g $pkg"
    return 1
  }
}

ensure_llm_clis() {
  if ! ensure_node; then
    warn "npm not available; skipping LLM CLI installation."
    warn "Install manually: npm install -g @anthropic-ai/claude-code @openai/codex"
    return
  fi
  install_cli claude @anthropic-ai/claude-code || true
  install_cli codex @openai/codex || true
}

# ------------------------------------------------------------------- tls ----
set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    echo "${key}=${val}" >> .env
  fi
}

get_env() { grep -E "^$1=" .env 2>/dev/null | head -n 1 | cut -d= -f2- || true; }

certs_exist() {
  local d="/etc/letsencrypt/live/$FQDN"
  # /etc/letsencrypt is usually root-only, so fall back to sudo for the check.
  if [ -r "$d/fullchain.pem" ] && [ -r "$d/privkey.pem" ]; then return 0; fi
  sudo test -r "$d/fullchain.pem" 2>/dev/null && sudo test -r "$d/privkey.pem" 2>/dev/null
}

# Rootful docker publishes low ports via the root daemon, so no capability is
# needed. Rootless docker binds host ports itself and needs
# CAP_NET_BIND_SERVICE on rootlesskit to bind 80/443.
ensure_port_bind_cap() {
  if ! $DOCKER info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
    return
  fi
  warn "rootless docker detected: it cannot read root-owned certs in /etc/letsencrypt,"
  warn "so nginx may fail to start unless the certs are readable by your user."
  local rk
  rk=$(command -v rootlesskit || true)
  if [ -z "$rk" ]; then
    warn "rootlesskit not found; binding ports 80/443 will likely fail."
    return
  fi
  if command -v getcap >/dev/null 2>&1 && getcap "$rk" 2>/dev/null | grep -q cap_net_bind_service; then
    return
  fi
  if ! command -v setcap >/dev/null 2>&1 && is_ubuntu; then
    sudo apt-get install -y libcap2-bin
  fi
  info "granting cap_net_bind_service to rootlesskit for ports 80/443 (requires sudo)..."
  sudo setcap cap_net_bind_service=ep "$rk"
  systemctl --user restart docker || \
    warn "could not restart rootless docker; restart it manually: systemctl --user restart docker"
}

setup_tls() {
  # Falling back to plain HTTP must also drop Secure from the session cookie —
  # a leftover SECURE_COOKIES=1 from an earlier TLS run would make every login
  # over http:// silently fail (the browser refuses to store the cookie).
  set_env SECURE_COOKIES 0
  # Remember the FQDN from a previous run so plain "./setup.sh" keeps TLS.
  if [ -z "$FQDN" ]; then
    FQDN=$(get_env FQDN)
  fi
  if [ -z "$FQDN" ]; then
    return
  fi
  if certs_exist; then
    info "TLS certs found in /etc/letsencrypt/live/$FQDN — enabling HTTPS on port 443"
    TLS_ENABLED=1
    set_env FQDN "$FQDN"
    set_env APP_PORT 80
    set_env COMPOSE_FILE "docker-compose.yml:docker-compose.tls.yml"
    set_env SECURE_COOKIES 1
    ensure_port_bind_cap
  else
    warn "no TLS certs in /etc/letsencrypt/live/$FQDN (need fullchain.pem + privkey.pem);"
    warn "staying on plain HTTP. Get certs with:"
    warn "  sudo certbot certonly --standalone -d $FQDN"
    warn "then re-run: ./setup.sh $FQDN"
    sed -i '/^COMPOSE_FILE=/d' .env
  fi
}

# ------------------------------------------------------------------- app ----
random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

ensure_docker
ensure_buildx
ensure_llm_clis

if [ ! -f .env ]; then
  cat > .env <<EOF
# Generated by setup.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)
POSTGRES_PASSWORD=$(random_hex)
APP_PORT=8080
EOF
  info "wrote .env with a random database password"
else
  info ".env already exists, keeping it"
fi

TLS_ENABLED=0
setup_tls

info "building images (this compiles the web client)..."
$DOCKER compose build

info "starting the database..."
$DOCKER compose up -d db
until $DOCKER compose exec -T db pg_isready -U eurorack -d eurorack >/dev/null 2>&1; do
  sleep 1
done

info "running database migrations..."
$DOCKER compose run --rm --no-deps server node scripts/migrate.js

# This app is pre-release: schema changes are folded into the initial
# migration, so a database initialized from an older revision can lack newer
# columns even though migrations report clean. Detect that and offer a reset.
SCHEMA_STATUS=$($DOCKER compose run --rm --no-deps -T server node scripts/check-schema.js 2>/dev/null | tail -n 1 | tr -d '\r' || true)
if [ "$SCHEMA_STATUS" != "ok" ]; then
  warn "the database schema does not match this revision (${SCHEMA_STATUS:-no response from schema check})"
  warn "fixing this recreates the docker volumes — ALL app data (users, modules, manuals) is lost."
  RESET_ANSWER="n"
  if [ "$INTERACTIVE" = "1" ]; then
    read -r -p "Recreate the database now? [y/N]: " RESET_ANSWER
  else
    warn "non-interactive shell: refusing to delete data."
  fi
  case "$RESET_ANSWER" in
    y|Y|yes|YES)
      info "recreating containers and volumes..."
      $DOCKER compose down -v
      info "starting the database..."
      $DOCKER compose up -d db
      until $DOCKER compose exec -T db pg_isready -U eurorack -d eurorack >/dev/null 2>&1; do
        sleep 1
      done
      info "running database migrations..."
      $DOCKER compose run --rm --no-deps server node scripts/migrate.js
      ;;
    *)
      echo "ERROR: cannot continue with a stale schema. Reset manually with:" >&2
      echo "  docker compose down -v && ./setup.sh" >&2
      exit 1
      ;;
  esac
fi

# Admin creation is skipped when an admin account already exists.
HAS_ADMIN=$($DOCKER compose run --rm --no-deps -T server node scripts/has-admin.js 2>/dev/null | tail -n 1 | tr -d '[:space:]' || true)
if [ "$HAS_ADMIN" = "yes" ]; then
  info "admin account already exists; skipping creation (./reset-admin-password.sh resets it)."
else
  info "creating the admin account..."
  $DOCKER compose run --rm --no-deps server node scripts/create-admin.js
fi

info "starting all services..."
$DOCKER compose up -d

echo ""
if [ "$TLS_ENABLED" = "1" ]; then
  info "done — the app is at https://$FQDN/"
  info "after cert renewals, reload nginx: $DOCKER compose exec nginx nginx -s reload"
  info "(e.g. as a certbot deploy hook)"
else
  APP_PORT=$(get_env APP_PORT)
  info "done — the app is at http://localhost:${APP_PORT:-8080}"
fi
if [ "$HAS_ADMIN" = "yes" ]; then
  info "log in with your existing admin credentials."
else
  info "log in with the admin credentials printed above."
fi
info "LLM accounts are per user: each user connects their own Claude or Codex"
info "account in the web UI under Account -> LLM provider before running LLM"
info "jobs (the site default provider is set on the admin Configuration page)."
