#!/usr/bin/env bash
# Knights of the Meadow: install, update or remove the game on a Linux VPS, run from the VPS itself.
#
#   With a domain (HTTPS is set up automatically):
#     curl -fsSL https://raw.githubusercontent.com/ahmadsalahudin/knight-fps/main/deploy/install.sh \
#       | sudo bash -s -- --domain game.example.com --email you@example.com
#
#   Without a domain (plain HTTP on the server's IP, port 80):
#     curl -fsSL https://raw.githubusercontent.com/ahmadsalahudin/knight-fps/main/deploy/install.sh | sudo bash
#
#   Update to the latest game later (keeps your settings):
#     curl -fsSL https://raw.githubusercontent.com/ahmadsalahudin/knight-fps/main/deploy/install.sh | sudo bash -s -- --update
#
# The game is one static file (knights_out_final.html) downloaded from GitHub and served as index.html by Caddy
# (default) or nginx (used automatically when nginx is already running). Supports Debian/Ubuntu (apt) and
# Fedora/RHEL/Rocky/Alma (dnf). Run with --help for every option.

set -euo pipefail

REPO="${KNIGHTS_REPO:-ahmadsalahudin/knight-fps}"
GAME_FILE="knights_out_final.html"
CONF_FILE="/etc/knights-deploy.conf"
SITE="knights"
MARKER="# Managed by knight-fps deploy/install.sh"

# ---- settings (command line > saved config > defaults) ----------------------------------------------------------
DOMAIN=""
EMAIL=""
PORT=""
REF=""
WEBROOT=""
SERVER=""
ACTION="install"   # install | update | rollback | uninstall | status
HTTPS_READY=1      # set to 0 when certbot could not get a certificate (nginx only; Caddy keeps retrying by itself)

usage() {
  cat <<'EOF'
Knights of the Meadow VPS installer

Usage: sudo bash install.sh [options]

  --domain NAME     Serve on this domain with automatic HTTPS (point its DNS A/AAAA record at this server first).
  --email ADDR      Contact email for the HTTPS certificate (recommended with --domain).
  --port N          HTTP port when no domain is given (default 80).
  --server NAME     caddy | nginx | auto (default auto: nginx if it is already running, otherwise caddy).
  --ref REF         Git branch, tag or commit of the game to deploy (default main).
  --dir PATH        Web root (default /var/www/knights).

  --update          Only download the latest game file; leave the web server alone.
  --rollback        Put back the previously deployed game file.
  --status          Show what is deployed and where.
  --uninstall       Remove the site config and web root (the web server package stays installed).
  -h, --help        Show this help.

Settings are saved in /etc/knights-deploy.conf, so re-running with no options repeats the last setup.
For a private fork, run with: sudo KNIGHTS_GITHUB_TOKEN=<token> bash install.sh ...
EOF
}

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Load saved settings first, so command-line options override them.
if [[ -r "$CONF_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONF_FILE"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)    DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
    --email)     EMAIL="${2:?--email needs a value}"; shift 2 ;;
    --port)      PORT="${2:?--port needs a value}"; shift 2 ;;
    --server)    SERVER="${2:?--server needs a value}"; shift 2 ;;
    --ref)       REF="${2:?--ref needs a value}"; shift 2 ;;
    --dir)       WEBROOT="${2:?--dir needs a value}"; shift 2 ;;
    --no-domain) DOMAIN=""; shift ;;
    --update)    ACTION="update"; shift ;;
    --rollback)  ACTION="rollback"; shift ;;
    --status)    ACTION="status"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

PORT="${PORT:-80}"
REF="${REF:-main}"
WEBROOT="${WEBROOT:-/var/www/knights}"
SERVER="${SERVER:-auto}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then die "--port must be a number between 1 and 65535"; fi
[[ -z "$DOMAIN" || "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "--domain looks invalid: $DOMAIN"
[[ "$SERVER" =~ ^(auto|caddy|nginx)$ ]] || die "--server must be caddy, nginx or auto"
[[ "$WEBROOT" == /* && "$WEBROOT" != "/" ]] || die "--dir must be an absolute path other than /"
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "--ref looks invalid: $REF"
if [[ -n "$DOMAIN" && "$PORT" != "80" ]]; then
  warn "--port is ignored when --domain is set (HTTPS needs ports 80 and 443)"
  PORT=80
fi

[[ $EUID -eq 0 ]] || die "run as root, e.g. prefix the command with sudo"
command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) is required"

# ---- helpers --------------------------------------------------------------------------------------------------------
PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt"
elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
fi

APT_UPDATED=0
pkg_install() {
  case "$PKG" in
    apt)
      if [[ $APT_UPDATED -eq 0 ]]; then DEBIAN_FRONTEND=noninteractive apt-get update -qq </dev/null; APT_UPDATED=1; fi
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null </dev/null ;;
    dnf) dnf install -y -q "$@" >/dev/null </dev/null ;;
    *) die "unsupported system: need apt-get (Debian/Ubuntu) or dnf (Fedora/RHEL family). Install a web server yourself and copy $GAME_FILE to $WEBROOT/index.html" ;;
  esac
}

is_active() { systemctl is-active --quiet "$1" 2>/dev/null; }

# Fail early, with a clear message, when another program already listens on a port the chosen server needs.
require_ports_free() {  # $1 = the web server allowed to hold them; remaining args = ports
  local allowed="$1"; shift
  command -v ss >/dev/null 2>&1 || return 0
  local p out owner
  for p in "$@"; do
    out="$(ss -Hltnp "sport = :$p" 2>/dev/null || true)"
    [[ -n "$out" ]] || continue
    owner="$(grep -o 'users:(("[^"]*' <<<"$out" | head -1 | cut -d'"' -f2)"
    [[ "$owner" == "$allowed" ]] && continue
    die "port $p is already used by '${owner:-another program}'. Stop it, or rerun with --server nginx if it is nginx, or use --port with a free port (no domain)."
  done
}

curl_gh() {
  # curl for GitHub; all arguments are passed through. KNIGHTS_GITHUB_TOKEN is only needed for a private fork. If the
  # token is rejected (GitHub answers 404 for a bad token even on public files), retry without it.
  if [[ -n "${KNIGHTS_GITHUB_TOKEN:-}" ]] && curl -fsSL --retry 3 --connect-timeout 15 -H "Authorization: token $KNIGHTS_GITHUB_TOKEN" "$@"; then
    return 0
  fi
  curl -fsSL --retry 3 --connect-timeout 15 "$@"
}

save_config() {
  umask 022
  cat > "$CONF_FILE" <<EOF
$MARKER: settings reused on the next run.
DOMAIN=$(printf '%q' "$DOMAIN")
EMAIL=$(printf '%q' "$EMAIL")
PORT=$(printf '%q' "$PORT")
SERVER=$(printf '%q' "$SERVER")
REF=$(printf '%q' "$REF")
WEBROOT=$(printf '%q' "$WEBROOT")
EOF
}

site_url() {
  if [[ -n "$DOMAIN" && "$HTTPS_READY" == 1 ]]; then echo "https://$DOMAIN/"
  elif [[ -n "$DOMAIN" ]]; then echo "http://$DOMAIN/"
  else
    local ip
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [[ "$PORT" == "80" ]]; then echo "http://${ip:-YOUR_SERVER_IP}/"; else echo "http://${ip:-YOUR_SERVER_IP}:$PORT/"; fi
  fi
}

# ---- game file ------------------------------------------------------------------------------------------------------
deploy_game() {
  command -v curl >/dev/null 2>&1 || pkg_install curl
  local url="https://raw.githubusercontent.com/$REPO/$REF/$GAME_FILE"
  local tmp
  tmp="$(mktemp)"
  log "Downloading the game ($REPO @ $REF)"
  curl_gh -o "$tmp" "$url" || { rm -f "$tmp"; die "could not download $url"; }

  # Refuse to publish anything that is not the game (an error page, a truncated download, ...).
  local size
  size="$(wc -c < "$tmp")"
  if (( size < 200000 )) || ! grep -q '<title>Knights of the Meadow</title>' "$tmp"; then
    rm -f "$tmp"
    die "the downloaded file does not look like the game ($size bytes); nothing was changed"
  fi

  local commit
  commit="$(curl_gh -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$REPO/commits/$REF" 2>/dev/null || true)"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || commit="unknown"

  mkdir -p "$WEBROOT"
  chmod 755 "$WEBROOT"
  if [[ -f "$WEBROOT/index.html" ]]; then
    if cmp -s "$tmp" "$WEBROOT/index.html"; then
      rm -f "$tmp"
      log "Game is already up to date (${commit:0:7})"
      return
    fi
    cp -p "$WEBROOT/index.html" "$WEBROOT/.index.html.prev"
    [[ -f "$WEBROOT/.version" ]] && cp -p "$WEBROOT/.version" "$WEBROOT/.version.prev"
  fi
  # Atomic swap: write next to the target, then rename, so players never get half a file.
  install -m 0644 "$tmp" "$WEBROOT/.index.html.new"
  mv -f "$WEBROOT/.index.html.new" "$WEBROOT/index.html"
  rm -f "$tmp"
  printf '%s %s %s\n' "$REF" "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WEBROOT/.version"
  command -v restorecon >/dev/null 2>&1 && restorecon -R "$WEBROOT" >/dev/null 2>&1 || true
  log "Deployed game $((size / 1024)) KB (commit ${commit:0:7}) to $WEBROOT/index.html"
}

rollback_game() {
  [[ -f "$WEBROOT/.index.html.prev" ]] || die "no previous version to roll back to in $WEBROOT"
  mv -f "$WEBROOT/index.html" "$WEBROOT/.index.html.rolledback"
  mv -f "$WEBROOT/.index.html.prev" "$WEBROOT/index.html"
  mv -f "$WEBROOT/.index.html.rolledback" "$WEBROOT/.index.html.prev"
  if [[ -f "$WEBROOT/.version.prev" ]]; then
    mv -f "$WEBROOT/.version" "$WEBROOT/.version.rolledback" 2>/dev/null || true
    mv -f "$WEBROOT/.version.prev" "$WEBROOT/.version"
    mv -f "$WEBROOT/.version.rolledback" "$WEBROOT/.version.prev" 2>/dev/null || true
  fi
  log "Rolled back to the previous game file (run --rollback again to undo)"
}

# ---- web server selection -------------------------------------------------------------------------------------------
choose_server() {
  if [[ "$SERVER" == "auto" ]]; then
    if is_active nginx; then SERVER="nginx"
    elif is_active apache2 || is_active httpd; then
      die "Apache is running on this server and already uses port 80. Either rerun with '--server caddy --port 8080' (no domain), or serve $WEBROOT from Apache yourself."
    else SERVER="caddy"
    fi
  fi
  log "Web server: $SERVER"
}

open_firewall() {
  local ports=("$PORT")
  [[ -n "$DOMAIN" ]] && ports=(80 443)
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    for p in "${ports[@]}"; do ufw allow "$p/tcp" >/dev/null; done
    log "Firewall (ufw): opened ${ports[*]}/tcp"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    for p in "${ports[@]}"; do firewall-cmd --permanent --add-port="$p/tcp" >/dev/null; done
    firewall-cmd --reload >/dev/null
    log "Firewall (firewalld): opened ${ports[*]}/tcp"
  fi
}

check_dns() {
  [[ -n "$DOMAIN" ]] || return 0
  if ! getent ahosts "$DOMAIN" >/dev/null 2>&1; then
    warn "$DOMAIN does not resolve yet. Create a DNS A record pointing to this server; HTTPS will start working once it does."
  fi
}

# ---- Caddy ----------------------------------------------------------------------------------------------------------
install_caddy() {
  command -v caddy >/dev/null 2>&1 && return
  log "Installing Caddy"
  if [[ "$PKG" == "apt" ]]; then
    if ! pkg_install caddy 2>/dev/null; then
      # Older releases (e.g. Ubuntu 22.04) do not ship caddy: use the official Caddy repository.
      pkg_install debian-keyring debian-archive-keyring apt-transport-https curl gnupg
      curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      APT_UPDATED=0
      pkg_install caddy
    fi
  elif [[ "$PKG" == "dnf" ]]; then
    if ! pkg_install caddy 2>/dev/null; then
      pkg_install 'dnf-command(copr)'
      dnf copr enable -y @caddy/caddy >/dev/null </dev/null
      pkg_install caddy
    fi
  else
    pkg_install caddy
  fi
}

configure_caddy() {
  local main=/etc/caddy/Caddyfile dir=/etc/caddy/conf.d site_file
  site_file="$dir/$SITE.caddy"
  mkdir -p "$dir"

  local backup=""
  if [[ -f "$main" ]]; then backup="$main.bak.$(date +%s)"; cp -p "$main" "$backup"; fi

  # The packaged default Caddyfile (a placeholder site on :80) is replaced by an import of conf.d; a Caddyfile you
  # wrote yourself is kept and only gets the import line added.
  if [[ ! -s "$main" ]] || grep -q 'The Caddyfile is an easy way to configure your Caddy web server' "$main" || grep -qF "$MARKER" "$main"; then
    printf '%s\n# Site files live in %s/\nimport %s/*.caddy\n' "$MARKER" "$dir" "$dir" > "$main"
  elif ! grep -qE "^[[:space:]]*import[[:space:]]+$dir/\*\.caddy" "$main"; then
    printf '\n%s\nimport %s/*.caddy\n' "$MARKER" "$dir" >> "$main"
  fi

  local address tls_line=""
  if [[ -n "$DOMAIN" ]]; then
    address="$DOMAIN"
    [[ -n "$EMAIL" ]] && tls_line="    tls $EMAIL"
  else
    address=":$PORT"
  fi

  cat > "$site_file" <<EOF
$MARKER
$address {
    root * $WEBROOT
    encode zstd gzip
    file_server
$tls_line
    @hidden path /.*
    respond @hidden 404
    header {
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
    }
    header / Cache-Control "no-cache"
}
EOF

  if ! caddy validate --config "$main" --adapter caddyfile >/tmp/knights-caddy-validate.log 2>&1; then
    cat /tmp/knights-caddy-validate.log >&2
    rm -f "$site_file"
    if [[ -n "$backup" ]]; then cp -p "$backup" "$main"; fi
    die "Caddy rejected the configuration (shown above); your previous Caddyfile was restored"
  fi
  rm -f /tmp/knights-caddy-validate.log

  systemctl enable caddy >/dev/null 2>&1 || true
  if is_active caddy; then systemctl reload caddy || systemctl restart caddy
  else systemctl start caddy
  fi
  log "Caddy configured: $site_file"
}

# ---- nginx ----------------------------------------------------------------------------------------------------------
nginx_conf_path() {
  if [[ -d /etc/nginx/sites-available ]]; then echo "/etc/nginx/sites-available/$SITE"
  else echo "/etc/nginx/conf.d/$SITE.conf"; fi
}

configure_nginx() {
  command -v nginx >/dev/null 2>&1 || { log "Installing nginx"; pkg_install nginx; }
  local conf listen server_name
  conf="$(nginx_conf_path)"

  # Listen on IPv6 too, but only where the host has it: nginx refuses to start on a [::] listen without IPv6.
  local has_v6=0
  [[ -f /proc/net/if_inet6 ]] && has_v6=1
  if [[ -n "$DOMAIN" ]]; then
    listen="listen 80;"
    (( has_v6 )) && listen+=$'\n    listen [::]:80;'
    server_name="$DOMAIN"
  else
    listen="listen $PORT default_server;"
    (( has_v6 )) && listen+=$'\n    listen [::]:'"$PORT"' default_server;'
    server_name="_"
    # The stock "Welcome to nginx" site also claims default_server on port 80; disable it (only that symlink).
    if [[ "$PORT" == "80" && -L /etc/nginx/sites-enabled/default ]]; then
      rm -f /etc/nginx/sites-enabled/default
      log "Disabled the stock nginx default site (re-enable: ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/)"
    fi
  fi

  # Keep the HTTPS block certbot may have added to an earlier version of this file.
  if [[ -f "$conf" ]] && grep -q 'managed by Certbot' "$conf" && [[ -n "$DOMAIN" ]]; then
    log "Keeping the existing certbot-managed nginx config: $conf"
  else
    cat > "$conf" <<EOF
$MARKER
server {
    $listen
    server_name $server_name;

    root $WEBROOT;
    index index.html;

    gzip on;
    gzip_comp_level 6;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    location = /index.html {
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
    }
    location ~ /\\. { return 404; }
    location / { try_files \$uri \$uri/ =404; }
}
EOF
  fi
  if [[ -d /etc/nginx/sites-enabled ]]; then ln -sfn "$conf" "/etc/nginx/sites-enabled/$SITE"; fi

  if ! nginx -t >/tmp/knights-nginx-test.log 2>&1; then
    cat /tmp/knights-nginx-test.log >&2
    rm -f "$conf" "/etc/nginx/sites-enabled/$SITE"
    die "nginx rejected the configuration (shown above); the knights site config was removed"
  fi
  rm -f /tmp/knights-nginx-test.log
  systemctl enable nginx >/dev/null 2>&1 || true
  if is_active nginx; then systemctl reload nginx; else systemctl start nginx; fi
  log "nginx configured: $conf"

  if [[ -n "$DOMAIN" ]]; then
    command -v certbot >/dev/null 2>&1 || { log "Installing certbot"; pkg_install certbot python3-certbot-nginx || { HTTPS_READY=0; warn "could not install certbot; HTTPS is not set up"; }; }
    if command -v certbot >/dev/null 2>&1; then
      local mail_args=(--register-unsafely-without-email)
      [[ -n "$EMAIL" ]] && mail_args=(-m "$EMAIL")
      if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect "${mail_args[@]}" </dev/null; then
        log "HTTPS certificate installed for $DOMAIN"
      else
        HTTPS_READY=0
        warn "certbot could not get a certificate (is the DNS record pointing here yet?). The game is on http://$DOMAIN/ for now; rerun this script to retry HTTPS."
      fi
    fi
  fi
}

# ---- checks, status, uninstall --------------------------------------------------------------------------------------
smoke_test() {
  # Ask the local web server for the page. A reload takes a moment to swap workers, so retry briefly. With a domain,
  # Caddy and certbot answer plain HTTP with a redirect to HTTPS, which also proves the site is wired up.
  local url="http://127.0.0.1:$PORT/" host=() body code
  [[ -n "$DOMAIN" ]] && { url="http://127.0.0.1/"; host=(-H "Host: $DOMAIN"); }
  for _ in 1 2 3 4 5 6; do
    body="$(curl -s -m 10 "${host[@]}" -w '\n%{http_code}' "$url" || true)"
    code="${body##*$'\n'}"
    if [[ "$code" =~ ^3 ]] || { [[ "$code" == 200 ]] && grep -q '<title>Knights of the Meadow</title>' <<<"$body"; }; then
      log "Local check: the game is being served ($code)"
      return 0
    fi
    sleep 1
  done
  warn "local check did not get the game from the web server (last HTTP status '$code'); see 'systemctl status $SERVER'"
}

show_status() {
  echo "Settings ($CONF_FILE): domain='${DOMAIN:-none}' port=$PORT server=$SERVER ref=$REF webroot=$WEBROOT"
  if [[ -f "$WEBROOT/.version" ]]; then
    read -r v_ref v_commit v_time < "$WEBROOT/.version"
    echo "Deployed: $v_ref @ ${v_commit:0:7} at $v_time"
  else
    echo "Deployed: nothing in $WEBROOT yet"
  fi
  echo "URL: $(site_url)"
}

uninstall() {
  rm -f /etc/caddy/conf.d/$SITE.caddy "/etc/nginx/sites-enabled/$SITE" "/etc/nginx/sites-available/$SITE" "/etc/nginx/conf.d/$SITE.conf"
  if is_active caddy; then systemctl reload caddy || true; fi
  if is_active nginx; then systemctl reload nginx || true; fi
  rm -rf "$WEBROOT"
  rm -f "$CONF_FILE"
  log "Removed the site config, $WEBROOT and $CONF_FILE (web server packages and certificates were left installed)"
}

# ---- main -----------------------------------------------------------------------------------------------------------
case "$ACTION" in
  status)    show_status ;;
  rollback)  rollback_game ;;
  uninstall) uninstall ;;
  update)
    deploy_game
    save_config
    log "Done: $(site_url)"
    ;;
  install)
    command -v curl >/dev/null 2>&1 || pkg_install curl
    deploy_game
    choose_server
    check_dns
    if [[ -n "$DOMAIN" ]]; then require_ports_free "$SERVER" 80 443; else require_ports_free "$SERVER" "$PORT"; fi
    if [[ "$SERVER" == "caddy" ]]; then install_caddy; configure_caddy; else configure_nginx; fi
    open_firewall
    save_config
    smoke_test
    log "Done. Play at: $(site_url)"
    log "Update later with: curl -fsSL https://raw.githubusercontent.com/$REPO/main/deploy/install.sh | sudo bash -s -- --update"
    ;;
esac
