#!/usr/bin/env bash
# Guided installer: installs dependencies, configures the admin password,
# builds the frontend, and wires up systemd services (+ optionally Caddy).
# Safe to re-run -- each step asks before overwriting anything it already set up.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="$(id -un)"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; }

ask() {
  # ask "prompt" "default" -> prints answer (default used on empty input)
  local prompt="$1" default="${2:-}" reply
  if [ -n "$default" ]; then
    read -r -p "  $prompt [$default]: " reply || true
    echo "${reply:-$default}"
  else
    read -r -p "  $prompt: " reply || true
    echo "$reply"
  fi
}

confirm() {
  # confirm "prompt" -> 0 (yes) or 1 (no), defaults to yes
  local prompt="$1" reply
  read -r -p "  $prompt [Y/n]: " reply || true
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

bold "Ham radio station site -- guided setup"
info "Installing into: $APP_DIR"
echo

# --- 1. Bun ---------------------------------------------------------------
bold "1. Runtime"
if command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
  ok "Bun found at $BUN_BIN ($(bun --version))"
else
  warn "Bun not found."
  if confirm "Install it now (curl -fsSL https://bun.sh/install | bash)?"; then
    curl -fsSL https://bun.sh/install | bash
    BUN_BIN="$HOME/.bun/bin/bun"
    if [ ! -x "$BUN_BIN" ]; then
      err "Bun install finished but $BUN_BIN isn't there -- install it yourself and re-run this script."
      exit 1
    fi
    ok "Bun installed at $BUN_BIN"
  else
    err "Bun is required. Install it from https://bun.sh and re-run this script."
    exit 1
  fi
fi
echo

# --- 2. Dependencies -------------------------------------------------------
bold "2. Dependencies"
info "Installing API dependencies..."
(cd "$APP_DIR/api" && "$BUN_BIN" install --silent)
ok "api/ dependencies installed"
info "Installing frontend dependencies..."
(cd "$APP_DIR/web" && "$BUN_BIN" install --silent)
ok "web/ dependencies installed"
echo

# --- 3. Configuration (api/.env) -------------------------------------------
bold "3. Configuration"
ENV_FILE="$APP_DIR/api/.env"
if [ -f "$ENV_FILE" ]; then
  warn "api/.env already exists."
  if ! confirm "Overwrite it? (No keeps the existing file and just re-checks the admin password below)"; then
    KEEP_ENV=1
  fi
fi

if [ -z "${KEEP_ENV:-}" ]; then
  DATA_DIR="$(ask "Where should the database and uploaded photos live? A relative path is under api/" "./data")"
  cat > "$ENV_FILE" <<EOF
PORT=3000
DATA_DIR=$DATA_DIR
# Generate with: bun scripts/set-password.ts <your-password>
ADMIN_PASSWORD_HASH=
# Set from /admin once the site is running, or with:
# bun scripts/set-qrz-key.ts <your-qrz-api-key>
QRZ_API_KEY=
# FlexRadio local-network IP (port 4992/4991) for live station status on
# /radio. Leave blank if you don't have one -- that dashboard just stays hidden.
FLEX_RADIO_IP=
# Public URL this site will be reachable at, used only for the "Live spots"
# link in needed-DX/VHF alert emails and pushes. Leave blank to omit the link.
SITE_URL=
EOF
  ok "Wrote api/.env"
fi

echo
if confirm "Set the admin password now?"; then
  while true; do
    PASSWORD="$(ask "Admin password (used to log into /admin)" "")"
    if [ -n "$PASSWORD" ]; then break; fi
    warn "Password can't be blank."
  done
  (cd "$APP_DIR/api" && "$BUN_BIN" scripts/set-password.ts "$PASSWORD")
  unset PASSWORD
else
  warn "Skipping -- run 'bun scripts/set-password.ts <password>' from api/ before starting the service, or /admin login won't work."
fi
echo

# --- 4. Build the frontend --------------------------------------------------
bold "4. Build"
(cd "$APP_DIR/web" && "$BUN_BIN" run build)
ok "Frontend built to web/dist"
echo

# --- 5. systemd services -----------------------------------------------------
bold "5. Background services"
if ! command -v systemctl >/dev/null 2>&1; then
  warn "systemctl not found -- skipping service setup. This installer targets systemd-based Linux (Debian, Raspberry Pi OS, Ubuntu, etc.)."
  warn "You can still run the API manually with: cd api && bun run start"
else
  if confirm "Install and start the API + sync/alert timers as systemd services (needs sudo)?"; then
    TMP_UNITS="$(mktemp -d)"
    trap 'rm -rf "$TMP_UNITS"' EXIT

    for f in "$APP_DIR"/deploy/hamstation-*.service "$APP_DIR"/deploy/hamstation-*.timer; do
      name="$(basename "$f")"
      sed \
        -e "s#__APP_DIR__#$APP_DIR#g" \
        -e "s#__APP_USER__#$APP_USER#g" \
        -e "s#__BUN_BIN__#$BUN_BIN#g" \
        "$f" > "$TMP_UNITS/$name"
    done

    sudo cp "$TMP_UNITS"/hamstation-*.service "$TMP_UNITS"/hamstation-*.timer /etc/systemd/system/
    sudo systemctl daemon-reload
    ok "Unit files installed to /etc/systemd/system"

    sudo systemctl enable --now hamstation-api
    ok "hamstation-api started"

    info "Enabling sync/alert timers -- the ones needing credentials (QRZ, eQSL, LoTW)"
    info "will just log 'not configured' until you set those up under Admin."
    for t in "$APP_DIR"/deploy/hamstation-*.timer; do
      tname="$(basename "$t")"
      sudo systemctl enable --now "$tname" >/dev/null
    done
    ok "Timers enabled"

    echo
    info "Check status any time with: systemctl status hamstation-api"
    info "Watch a sync run with:      journalctl -u hamstation-lotw-sync -f"
  else
    warn "Skipped. Run the API manually with: cd api && bun run start"
  fi
fi
echo

# --- 6. Caddy (reverse proxy + static files) --------------------------------
bold "6. Web server (Caddy)"
info "Caddy serves the built frontend and reverse-proxies /api, /media, and /ws"
info "to the API. Skip this if you're fronting the site with something else."
if confirm "Set up Caddy now?"; then
  if ! command -v caddy >/dev/null 2>&1; then
    warn "Caddy isn't installed."
    if command -v apt-get >/dev/null 2>&1 && confirm "Install it via apt (adds Caddy's official repo)?"; then
      sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | sudo tee /etc/apt/sources.list.d/caddy-stable.list
      sudo apt-get update
      sudo apt-get install -y caddy
      ok "Caddy installed"
    else
      warn "Install Caddy yourself (https://caddyserver.com/docs/install), then re-run this step."
    fi
  fi

  if command -v caddy >/dev/null 2>&1; then
    DOMAIN="$(ask "Domain name (e.g. mystation.example.com), or leave blank for local-network-only on port 80" "")"
    if [ -z "$DOMAIN" ]; then
      DOMAIN=":80"
      warn "No domain given -- serving plain HTTP on port 80, no automatic HTTPS."
    fi
    sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__APP_DIR__#$APP_DIR#g" \
      "$APP_DIR/deploy/Caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
    sudo systemctl enable --now caddy
    sudo systemctl restart caddy
    ok "Caddy configured and (re)started"
    echo
    if [ "$DOMAIN" = ":80" ]; then
      info "Visit: http://$(hostname -I 2>/dev/null | awk '{print $1}')/admin"
    else
      info "Visit: https://$DOMAIN/admin  (HTTPS cert issues automatically on first request --"
      info "make sure $DOMAIN's DNS already points here and ports 80/443 reach this machine)"
    fi
  fi
else
  warn "Skipped. Point your own web server at web/dist (static files) and reverse-proxy"
  warn "/api, /media, and /ws to http://localhost:3000 -- see deploy/Caddyfile for reference."
fi
echo

# --- 7. Reboot capability (Device Stats page) --------------------------------
bold "7. Reboot capability"
info "The Device Stats page has an admin-only 'Reboot device' button. Using it"
info "requires a narrowly-scoped sudo rule granting $APP_USER passwordless sudo"
info "for exactly 'systemctl reboot' -- nothing broader. Skip this if you'd"
info "rather reboot the machine yourself over SSH; the button will just fail."
if confirm "Grant that sudo rule now?"; then
  TMP_SUDOERS="$(mktemp)"
  sed "s#__APP_USER__#$APP_USER#g" "$APP_DIR/deploy/hamstation-reboot-sudoers" > "$TMP_SUDOERS"
  if sudo visudo -c -f "$TMP_SUDOERS" >/dev/null 2>&1; then
    sudo install -m 0440 -o root -g root "$TMP_SUDOERS" /etc/sudoers.d/hamstation-reboot
    ok "Sudo rule installed"
  else
    err "Generated sudoers file failed validation -- skipping, nothing installed."
  fi
  rm -f "$TMP_SUDOERS"
else
  warn "Skipped. The Reboot device button will show an error until this is set up manually --"
  warn "see deploy/hamstation-reboot-sudoers."
fi
echo

bold "Done."
info "Next: log into /admin and set your callsign, station location, and any"
info "service credentials (QRZ, eQSL, LoTW, HamQTH) you want to use."
info "Historical solar data (optional, back to 1932) can be backfilled with:"
info "  cd api && bun scripts/import-solar-data.ts"
