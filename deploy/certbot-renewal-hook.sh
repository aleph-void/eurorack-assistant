#!/usr/bin/env bash
#
# eurorack-assistant — frees port 80 for a Let's Encrypt renewal.
#
# A cert certbot issued with --standalone is renewed the same way: certbot
# answers the HTTP-01 challenge on port 80 itself, and once TLS is on, nginx
# is holding that port. Installed twice by ./setup.sh, as
# /etc/letsencrypt/renewal-hooks/pre/eurorack-assistant (stops nginx) and
# /etc/letsencrypt/renewal-hooks/post/eurorack-assistant (starts it again,
# which also puts the renewed cert in service). certbot runs the pre hook only
# when a cert is really due, and the post hook only after a pre hook ran.
#
# Only an nginx that was RUNNING is started again: a stack somebody has taken
# down on purpose stays down, so the pre hook leaves a marker for the post hook.
#
# TEMPLATE: @APP_DIR@, @DOCKER_BIN@ and @HOOK@ (pre|post) are substituted at
# install time.
set -euo pipefail

MARKER="/run/eurorack-assistant-certbot-stopped-nginx"
cd "@APP_DIR@"

case "@HOOK@" in
  pre)
    rm -f "$MARKER"
    if [ -n "$("@DOCKER_BIN@" compose ps -q --status running nginx 2>/dev/null)" ]; then
      "@DOCKER_BIN@" compose stop nginx
      touch "$MARKER"
    fi
    ;;
  post)
    if [ -f "$MARKER" ]; then
      rm -f "$MARKER"
      "@DOCKER_BIN@" compose start nginx
    fi
    ;;
  *)
    echo "eurorack-assistant certbot hook: unknown hook '@HOOK@'" >&2
    exit 1
    ;;
esac
