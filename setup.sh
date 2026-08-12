#!/usr/bin/env bash
#
# One-shot setup for Eurorack Assistant.
#
#   1. Installs Docker (docker.io + docker-compose-v2) on Ubuntu if missing.
#   2. Installs the LLM provider CLIs (claude, codex) if missing.
#   3. Asks which provider to use and guides you through authenticating.
#   4. Generates secrets, builds containers, migrates the database.
#   5. Creates the admin account — its random password is printed ONCE below
#      and stored nowhere else in cleartext.
set -euo pipefail
cd "$(dirname "$0")"

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

# The server container mounts these host directories for the CLIs' logins.
claude_logged_in() { [ -f "$HOME/.claude/.credentials.json" ]; }
codex_logged_in() { [ -f "$HOME/.codex/auth.json" ]; }

PROVIDER=""

choose_provider() {
  if [ "$INTERACTIVE" != "1" ]; then
    info "non-interactive shell; skipping provider selection (defaults to claude)."
    info "You can change it later on the admin LLM Config page."
    return
  fi
  echo ""
  echo "Which LLM provider should answer questions and analyze manuals?"
  echo "  1) Claude Code  (Anthropic — Claude Pro/Max subscription)"
  echo "  2) Codex        (OpenAI — ChatGPT subscription)"
  echo "  s) skip for now (configure later on the admin LLM Config page)"
  local choice
  read -r -p "Choice [1/2/s]: " choice
  case "$choice" in
    1) PROVIDER="claude" ;;
    2) PROVIDER="codex" ;;
    *) info "skipping provider selection" ;;
  esac
}

authenticate_provider() {
  case "$PROVIDER" in
    claude)
      if claude_logged_in; then
        info "Claude Code is already logged in."
        return
      fi
      if ! command -v claude >/dev/null 2>&1; then
        warn "claude CLI not installed; cannot authenticate."
        return
      fi
      echo ""
      echo "Claude Code login: an interactive session will open."
      echo "  - Type /login and follow the browser prompts to sign in with your"
      echo "    Claude Pro/Max subscription."
      echo "  - Then type /exit (or press Ctrl+C) to come back to this script."
      read -r -p "Press Enter to launch claude... " _
      claude || true
      if claude_logged_in; then
        info "Claude Code login detected."
      else
        warn "no Claude Code login found ($HOME/.claude/.credentials.json missing)."
        warn "Run 'claude' and use /login before asking questions."
      fi
      ;;
    codex)
      if codex_logged_in; then
        info "Codex is already logged in."
        return
      fi
      if ! command -v codex >/dev/null 2>&1; then
        warn "codex CLI not installed; cannot authenticate."
        return
      fi
      echo ""
      echo "Codex login: choose 'Sign in with ChatGPT' and follow the browser prompts."
      codex login || true
      if codex_logged_in; then
        info "Codex login detected."
      else
        warn "no Codex login found ($HOME/.codex/auth.json missing)."
        warn "Run 'codex login' before asking questions."
      fi
      ;;
  esac
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
ensure_llm_clis
choose_provider
authenticate_provider

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

info "building images (this compiles the web client)..."
$DOCKER compose build

info "starting the database..."
$DOCKER compose up -d db
until $DOCKER compose exec -T db pg_isready -U eurorack -d eurorack >/dev/null 2>&1; do
  sleep 1
done

info "running database migrations..."
$DOCKER compose run --rm --no-deps server node scripts/migrate.js

if [ -n "$PROVIDER" ]; then
  info "setting LLM provider to '$PROVIDER'..."
  $DOCKER compose run --rm --no-deps server node scripts/set-config.js llm_provider "$PROVIDER"
fi

info "creating the admin account..."
$DOCKER compose run --rm --no-deps server node scripts/create-admin.js

info "starting all services..."
$DOCKER compose up -d

APP_PORT=$(grep -E '^APP_PORT=' .env | cut -d= -f2)
echo ""
info "done — the app is at http://localhost:${APP_PORT:-8080}"
info "log in with the admin credentials printed above."
if [ -z "$PROVIDER" ]; then
  info "LLM provider defaults to Claude Code; change it on the admin LLM Config page."
fi
