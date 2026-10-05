#!/bin/sh
# Installs PCP on Linux with Docker or Podman, from the published image.
#
#   curl -fsSL https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh | sh -s -- uninstall
#
# Finds Docker (a daemon you may talk to) or Podman, pulls
# ghcr.io/kaperkunde/pcp, and keeps PCP running on port 3000 with its data in
# the pcp-data volume: as a container Docker restarts, or as a Quadlet
# systemd unit under Podman (a plain `podman run` on Podman older than 4.4).
# Running it again updates PCP and keeps the settings below; `uninstall`
# removes the container and the unit and keeps the volume.
#
# Settings, by environment variable. The first four are remembered in
# ~/.config/pcp/install.conf, so a later run without them keeps them:
#
#   PCP_PORT=3000                     the port PCP answers on
#   PCP_HTTPS=1                       also publish 80 and 443 for PCP's own HTTPS
#   PCP_RUNTIME=docker|podman         skip the discovery
#   PCP_DATA_VOLUME=pcp-data          the volume that holds the vault
#   PCP_VERSION=latest                the image tag
#   PCP_IMAGE=ghcr.io/kaperkunde/pcp  the image
#
# It never runs sudo and never installs Docker or Podman itself: when neither
# is usable, it prints what to run. POSIX sh, so it runs under dash too.

set -eu

SCRIPT_URL="https://raw.githubusercontent.com/kaperkunde/pcp/main/install.sh"
GUIDE_URL="https://github.com/kaperkunde/pcp/blob/main/docs/self-hosting.md"
README_URL="https://github.com/kaperkunde/pcp#run-it"
DEFAULT_IMAGE="ghcr.io/kaperkunde/pcp"
CONTAINER="pcp"
PORT_FILE="/proc/sys/net/ipv4/ip_unprivileged_port_start"

# Each argument is a line.
say() { printf '%s\n' "$@"; }
warn() { printf '%s\n' "$@" >&2; }
die() {
  warn "$@"
  exit 1
}

usage() {
  warn "Usage: install.sh [uninstall]" "" \
    "Settings go in the environment: PCP_PORT, PCP_HTTPS, PCP_RUNTIME," \
    "PCP_DATA_VOLUME, PCP_VERSION, PCP_IMAGE. The top of the script explains them."
  exit 2
}

require_linux() {
  case "$(uname -s)" in
    Linux) ;;
    *) die "This installer is for Linux. On a Mac or a Windows PC, use the PCP app: $README_URL" ;;
  esac
}

# --- Settings ---------------------------------------------------------------

# Reads the remembered settings. An allow-list, not `. file`, so the file
# cannot run anything.
load_conf() {
  [ -f "$CONF" ] || return 0
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      PCP_PORT) conf_port=$value ;;
      PCP_HTTPS) conf_https=$value ;;
      PCP_RUNTIME) conf_runtime=$value ;;
      PCP_DATA_VOLUME) conf_volume=$value ;;
    esac
  done <"$CONF"
}

# The environment wins over the file, the file over the default.
resolve_settings() {
  conf_port=
  conf_https=
  conf_runtime=
  conf_volume=
  load_conf
  PCP_PORT=${PCP_PORT:-${conf_port:-3000}}
  PCP_HTTPS=${PCP_HTTPS:-${conf_https:-0}}
  PCP_RUNTIME=${PCP_RUNTIME:-${conf_runtime:-}}
  PCP_DATA_VOLUME=${PCP_DATA_VOLUME:-${conf_volume:-pcp-data}}
  PCP_VERSION=${PCP_VERSION:-latest}
  PCP_VERSION=${PCP_VERSION#v}
  PCP_IMAGE=${PCP_IMAGE:-$DEFAULT_IMAGE}
  IMAGE="$PCP_IMAGE:$PCP_VERSION"

  case "$PCP_PORT" in
    '' | *[!0-9]*) usage_error "PCP_PORT must be a port number, not '$PCP_PORT'." ;;
  esac
  case "$PCP_HTTPS" in
    0 | 1) ;;
    *) usage_error "PCP_HTTPS must be 0 or 1, not '$PCP_HTTPS'." ;;
  esac
  case "$PCP_RUNTIME" in
    '' | docker | podman) ;;
    *) usage_error "PCP_RUNTIME must be docker or podman, not '$PCP_RUNTIME'." ;;
  esac
  case "$PCP_DATA_VOLUME" in
    '' | *[!A-Za-z0-9_.-]*) usage_error "PCP_DATA_VOLUME must be a volume name (letters, digits, '_', '.', '-'), not '$PCP_DATA_VOLUME'." ;;
  esac
}

usage_error() {
  warn "$@"
  exit 2
}

save_conf() {
  mkdir -p "$(dirname "$CONF")"
  printf 'PCP_PORT=%s\nPCP_HTTPS=%s\nPCP_RUNTIME=%s\nPCP_DATA_VOLUME=%s\n' \
    "$PCP_PORT" "$PCP_HTTPS" "$RUNTIME" "$PCP_DATA_VOLUME" >"$CONF"
}

# --- Which runtime ----------------------------------------------------------

has() { command -v "$1" >/dev/null 2>&1; }

# The podman-docker package puts a `docker` that is Podman on the path.
docker_is_podman() {
  case "$(docker --version 2>/dev/null)" in
    *[Pp]odman*) return 0 ;;
  esac
  return 1
}

# A Docker daemon this user may talk to wins; otherwise Podman; otherwise
# the exact fix. The choice is remembered, so a later run stays with it.
pick_runtime() {
  if [ -n "$PCP_RUNTIME" ]; then
    has "$PCP_RUNTIME" || die "PCP_RUNTIME=$PCP_RUNTIME, but $PCP_RUNTIME is not installed."
    RUNTIME=$PCP_RUNTIME
    return 0
  fi
  if has docker; then
    if docker_is_podman; then
      if has podman; then
        RUNTIME=podman
        return 0
      fi
    elif docker info >/dev/null 2>&1; then
      RUNTIME=docker
      return 0
    fi
  fi
  if has podman; then
    RUNTIME=podman
    return 0
  fi
  if has docker; then
    docker_unusable
  fi
  no_runtime
}

docker_unusable() {
  error=$({ docker info >/dev/null; } 2>&1 || true)
  case "$error" in
    *"ermission denied"*)
      die "Docker is installed, but your user may not use it. Allow it:" "" \
        "  sudo usermod -aG docker $(id -un)" "" \
        "then log out and back in, and run this installer again."
      ;;
    *)
      die "Docker is installed, but its service is not running. Start it:" "" \
        "  sudo systemctl enable --now docker" "" \
        "If it then says your user may not use Docker:" \
        "  sudo usermod -aG docker $(id -un)" \
        "and log out and back in. Then run this installer again."
      ;;
  esac
}

no_runtime() {
  if [ -e /run/ostree-booted ]; then
    die "Neither Docker nor Podman is installed. This system (Fedora Atomic, Bazzite or similar) normally comes with Podman; install it with the system's own tooling, then run this installer again."
  fi
  die "Neither Docker nor Podman is installed. Install one, then run this installer again." "" \
    "Docker:" \
    "  curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $(id -un)" \
    "  (then log out and back in)" "" \
    "Podman: your distribution's package, for example apt install podman or dnf install podman."
}

# --- Podman: Quadlet or plain -----------------------------------------------

podman_version() {
  podman --version 2>/dev/null | awk '{print $NF}'
}

# Quadlet (a .container file systemd turns into a service) exists since 4.4.
podman_has_quadlet() {
  version=$(podman_version)
  major=${version%%.*}
  rest=${version#*.}
  minor=${rest%%.*}
  case "$major$minor" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -gt 4 ] || { [ "$major" -eq 4 ] && [ "$minor" -ge 4 ]; }
}

# systemctl for PCP's unit: the user's manager, or the system's for root.
unit_ctl() {
  if [ "$ROOT" = 1 ]; then
    systemctl "$@"
  else
    systemctl --user "$@"
  fi
}

# False under `su` or `sudo sh`, where there is no manager for the user.
systemd_ok() {
  has systemctl || return 1
  unit_ctl show-environment >/dev/null 2>&1
}

set_paths() {
  if [ "$ROOT" = 1 ]; then
    UNIT_DIR=/etc/containers/systemd
    WANTED_BY=multi-user.target
    JOURNAL="journalctl -u $CONTAINER -f"
  else
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
    WANTED_BY=default.target
    JOURNAL="journalctl --user -u $CONTAINER -f"
  fi
  UNIT="$UNIT_DIR/$CONTAINER.container"
  LOGS="$RUNTIME logs -f $CONTAINER"
}

# --- Checks before anything changes -----------------------------------------

# A compose checkout (docker-compose.yaml) runs PCP as pcp-pcp-1 on the
# same port; two copies would fight over it and over the data.
check_compose_install() {
  running=$("$RUNTIME" ps -q --filter "name=pcp[-_]pcp[-_]" 2>/dev/null || true)
  [ -z "$running" ] || die "PCP is already running from a checkout (docker compose). Stop it there first:" "" \
    "  $RUNTIME compose down" "" \
    "then run this installer again, with PCP_DATA_VOLUME=pcp_pcp-data to keep that vault."
}

# The first port a user without root may open. sysctl is not on every
# user's path (Debian keeps it in /usr/sbin), so /proc is the fallback.
unprivileged_port_start() {
  if has sysctl; then
    sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || true
  elif [ -r "$PORT_FILE" ]; then
    cat "$PORT_FILE"
  fi
}

# Podman without root may not open ports below 1024 unless the system allows
# it; better to say so now than to let the unit fail on the bind.
check_privileged_ports() {
  [ "$PCP_HTTPS" = 1 ] || return 0
  [ "$RUNTIME" = podman ] || return 0
  [ "$ROOT" = 0 ] || return 0
  start=$(unprivileged_port_start)
  case "$start" in
    '' | *[!0-9]*) return 0 ;;
  esac
  [ "$start" -gt 80 ] || return 0
  die "PCP_HTTPS=1 publishes ports 80 and 443, which Podman without root may not open on this system (ports below $start are reserved). Allow it once:" "" \
    "  echo net.ipv4.ip_unprivileged_port_start=80 | sudo tee /etc/sysctl.d/90-pcp.conf && sudo sysctl --system" "" \
    "then run this installer again."
}

# --- Install ----------------------------------------------------------------

pull_image() {
  say "Pulling $IMAGE"
  "$RUNTIME" pull "$IMAGE" || die "Could not pull $IMAGE. Check the message above, and that this computer reaches ghcr.io."
}

start_failed() {
  die "PCP did not start. If the message above names a port, another program on this computer uses it: choose another port with PCP_PORT=…, or leave PCP_HTTPS off and let a proxy of your own handle HTTPS." "" \
    "  $1"
}

# Docker, or Podman without Quadlet: one container the runtime restarts.
install_container() {
  pull_image
  "$RUNTIME" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  set -- -d --name "$CONTAINER" --restart unless-stopped -p "$PCP_PORT:3000"
  if [ "$PCP_HTTPS" = 1 ]; then
    set -- "$@" -p 80:8080 -p 443:8443
  fi
  "$RUNTIME" run "$@" -v "$PCP_DATA_VOLUME:/data" "$IMAGE" >/dev/null || start_failed "$LOGS"
}

write_unit() {
  mkdir -p "$UNIT_DIR"
  {
    printf '# PCP. Written by install.sh; running the installer again rewrites it.\n'
    printf '# Logs: %s\n' "$JOURNAL"
    printf '[Unit]\nDescription=PCP\n\n'
    printf '[Container]\nImage=%s\nContainerName=%s\n' "$IMAGE" "$CONTAINER"
    printf 'PublishPort=%s:3000\n' "$PCP_PORT"
    if [ "$PCP_HTTPS" = 1 ]; then
      printf 'PublishPort=80:8080\nPublishPort=443:8443\n'
    fi
    printf 'Volume=%s:/data\n' "$PCP_DATA_VOLUME"
    printf 'Label=io.containers.autoupdate=registry\n\n'
    printf '[Service]\nRestart=always\n\n'
    printf '[Install]\nWantedBy=%s\n' "$WANTED_BY"
  } >"$UNIT"
}

# Podman 4.4 or newer with systemd: a Quadlet unit, started now and at boot.
install_quadlet() {
  pull_image
  unit_ctl stop "$CONTAINER.service" >/dev/null 2>&1 || true
  podman rm -f "$CONTAINER" >/dev/null 2>&1 || true
  write_unit
  unit_ctl daemon-reload
  unit_ctl restart "$CONTAINER.service" || start_failed "$JOURNAL"
  LOGS=$JOURNAL
  if [ "$ROOT" = 0 ]; then
    loginctl enable-linger >/dev/null 2>&1 ||
      warn "Note: PCP stops when you log out until you run: loginctl enable-linger"
  fi
}

install_podman() {
  if ! podman_has_quadlet; then
    install_container
    warn "" "Note: Podman $(podman_version) is older than 4.4, so PCP does not come back after a reboot by itself. Run this installer again then, or update Podman and run it again."
  elif ! systemd_ok; then
    install_container
    warn "" "Note: there is no systemd session for this user, so PCP does not come back after a reboot by itself. Run this installer again then, from a normal login."
  else
    install_quadlet
  fi
}

# --- After starting ---------------------------------------------------------

fetch_ok() {
  if has curl; then
    curl -fs -o /dev/null --max-time 3 "$1"
  else
    wget -q -O /dev/null -T 3 -t 1 "$1"
  fi
}

container_running() {
  [ "$("$RUNTIME" inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)" = running ]
}

wait_for_health() {
  url="http://127.0.0.1:$PCP_PORT/api/health"
  if ! has curl && ! has wget; then
    warn "Neither curl nor wget is installed, so this installer cannot check that PCP answers. $LOGS shows what it is doing."
    return 0
  fi
  i=0
  while [ "$i" -lt 90 ]; do
    if fetch_ok "$url" 2>/dev/null; then
      return 0
    fi
    container_running || die "PCP stopped right after starting. See why with:" "" "  $LOGS"
    sleep 1
    i=$((i + 1))
  done
  die "PCP did not answer at $url within 90 seconds. See what it is doing with:" "" "  $LOGS"
}

lan_address() {
  address=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [ -z "$address" ]; then
    address=$(ip -4 route get 1.1.1.1 2>/dev/null |
      awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')
  fi
  printf '%s\n' "$address"
}

summary() {
  lan=$(lan_address)
  say "" "PCP is running." "" \
    "  On this computer:     http://localhost:$PCP_PORT"
  if [ -n "$lan" ]; then
    say "  From another device:  http://$lan:$PCP_PORT"
  fi
  say "" \
    "Open it now and set up your vault: the first person to open it becomes" \
    "its owner." "" \
    "  Update PCP   run this installer again" \
    "  Logs         $LOGS" \
    "  Your data    the $PCP_DATA_VOLUME volume; nothing else holds state" \
    "  Remove PCP   curl -fsSL $SCRIPT_URL | sh -s -- uninstall"
  if [ "$PCP_HTTPS" = 0 ]; then
    say "" \
      "To reach PCP from outside your home with its own HTTPS, run the installer" \
      "again with PCP_HTTPS=1 (it publishes ports 80 and 443) and follow" \
      "$GUIDE_URL"
  fi
}

install() {
  check_compose_install
  check_privileged_ports
  if [ "$RUNTIME" = docker ]; then
    install_container
  else
    install_podman
  fi
  save_conf
  wait_for_health
  summary
}

uninstall() {
  if [ "$RUNTIME" = podman ] && [ -f "$UNIT" ]; then
    unit_ctl stop "$CONTAINER.service" >/dev/null 2>&1 || true
    rm -f "$UNIT"
    unit_ctl daemon-reload >/dev/null 2>&1 || true
  fi
  "$RUNTIME" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -f "$CONF"
  say "PCP is removed. The $PCP_DATA_VOLUME volume, with your vault, is kept. To delete it too:" "" \
    "  $RUNTIME volume rm $PCP_DATA_VOLUME"
}

main() {
  case "${1:-}" in
    '' | uninstall) ;;
    *) usage ;;
  esac
  require_linux
  CONF="${XDG_CONFIG_HOME:-${HOME:?}/.config}/pcp/install.conf"
  if [ "$(id -u)" = 0 ]; then
    ROOT=1
  else
    ROOT=0
  fi
  resolve_settings
  pick_runtime
  set_paths
  if [ "${1:-}" = uninstall ]; then
    uninstall
  else
    install
  fi
}

main "$@"
