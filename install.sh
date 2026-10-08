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
# removes the container and the unit and keeps the volume. With
# PCP_AUTO_UPDATE=1 PCP is updated once a day by itself: under Podman with
# Quadlet by Podman's own podman-auto-update.timer, otherwise by a timer
# that runs a copy of this installer with `update`, which fetches the image
# and starts PCP again only when there is a new one.
#
# "Install and restart" on PCP's Settings page works through the same copy:
# a timer runs it with `watch` every 30 seconds, which looks for the request
# PCP leaves in its data folder (through `docker exec`) and then runs
# `update`. PCP itself still pulls and restarts nothing. PCP_UPDATE_BUTTON=0
# turns it off; a pinned PCP_VERSION has no use for it.
#
# Settings, by environment variable. The first six are remembered in
# ~/.config/pcp/install.conf, so a later run without them keeps them (run as
# root, in /etc/pcp/install.conf instead):
#
#   PCP_PORT=3000                     the port PCP answers on
#   PCP_HTTPS=1                       also publish 80 and 443 for PCP's own HTTPS
#   PCP_RUNTIME=docker|podman         skip the discovery
#   PCP_DATA_VOLUME=pcp-data          the volume that holds the vault
#   PCP_AUTO_UPDATE=1                 update PCP by itself, once a day
#   PCP_UPDATE_BUTTON=0               no "Install and restart" in PCP's Settings
#   PCP_VERSION=latest                the image tag
#   PCP_IMAGE=ghcr.io/kaperkunde/pcp  the image
#
# It never runs sudo and never installs Docker or Podman itself: when neither
# is usable, it prints what to run. POSIX sh, so it runs under dash too.
#
# The copy of this installer for the timers is kept in
# ~/.local/share/pcp/install.sh, or, when run as root, in
# /usr/local/lib/pcp/install.sh: root runs that file every day, so it and the
# settings it reads (/etc/pcp/install.conf) sit where only root writes,
# whatever HOME is. (An install run as root that finds only the older file in
# HOME carries its settings over once; the daily update never reads it.) The
# watcher notes the last request it answered in ~/.local/state/pcp, or as
# root in /var/lib/pcp. PCP_ROOT_PREFIX puts all of root's paths under another
# directory; it exists for the tests and nothing else.

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
  warn "Usage: install.sh [uninstall|update|watch]" "" \
    "Settings go in the environment: PCP_PORT, PCP_HTTPS, PCP_RUNTIME," \
    "PCP_DATA_VOLUME, PCP_AUTO_UPDATE, PCP_UPDATE_BUTTON, PCP_VERSION," \
    "PCP_IMAGE. The top of the script explains them."
  exit 2
}

require_linux() {
  case "$(uname -s)" in
    Linux) ;;
    *) die "This installer is for Linux. On a Mac or a Windows PC, use the PCP app: $README_URL" ;;
  esac
}

# --- Settings ---------------------------------------------------------------

# Reads the remembered settings from the file it is given. An allow-list, not
# `. file`, so the file cannot run anything.
load_conf() {
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      PCP_PORT) conf_port=$value ;;
      PCP_HTTPS) conf_https=$value ;;
      PCP_RUNTIME) conf_runtime=$value ;;
      PCP_DATA_VOLUME) conf_volume=$value ;;
      PCP_AUTO_UPDATE) conf_auto=$value ;;
      PCP_UPDATE_BUTTON) conf_button=$value ;;
    esac
  done <"$1"
}

# Where a root install before root had a place of its own kept its settings:
# in the user's config directory, which may be an ordinary user's.
legacy_conf() {
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then
    printf '%s\n' "$XDG_CONFIG_HOME/pcp/install.conf"
  elif [ -n "${HOME:-}" ]; then
    printf '%s\n' "$HOME/.config/pcp/install.conf"
  else
    return 1
  fi
}

# Root reads /etc/pcp/install.conf. Only when that is missing, and only in an
# install run (somebody typing the command, never the unattended update),
# the older file in HOME is read once through the same allow-list; the values
# are checked like any others, and save_conf then writes /etc/pcp/install.conf,
# so the file in HOME is not read again.
read_conf() {
  if [ -f "$CONF" ]; then
    load_conf "$CONF"
  elif [ "$ROOT" = 1 ] && [ "$MIGRATE" = 1 ] && old=$(legacy_conf) && [ -f "$old" ]; then
    warn "Note: carrying the settings in $old over to $CONF, which is where this installer keeps them as root from now on. $old is not read again."
    load_conf "$old"
  fi
}

# The environment wins over the file, the file over the default.
resolve_settings() {
  conf_port=
  conf_https=
  conf_runtime=
  conf_volume=
  conf_auto=
  conf_button=
  read_conf
  PCP_PORT=${PCP_PORT:-${conf_port:-3000}}
  PCP_HTTPS=${PCP_HTTPS:-${conf_https:-0}}
  PCP_RUNTIME=${PCP_RUNTIME:-${conf_runtime:-}}
  PCP_DATA_VOLUME=${PCP_DATA_VOLUME:-${conf_volume:-pcp-data}}
  PCP_AUTO_UPDATE=${PCP_AUTO_UPDATE:-${conf_auto:-0}}
  PCP_UPDATE_BUTTON=${PCP_UPDATE_BUTTON:-${conf_button:-1}}
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
  case "$PCP_AUTO_UPDATE" in
    0 | 1) ;;
    *) usage_error "PCP_AUTO_UPDATE must be 0 or 1, not '$PCP_AUTO_UPDATE'." ;;
  esac
  case "$PCP_UPDATE_BUTTON" in
    0 | 1) ;;
    *) usage_error "PCP_UPDATE_BUTTON must be 0 or 1, not '$PCP_UPDATE_BUTTON'." ;;
  esac
  case "$PCP_RUNTIME" in
    '' | docker | podman) ;;
    *) usage_error "PCP_RUNTIME must be docker or podman, not '$PCP_RUNTIME'." ;;
  esac
  case "$PCP_DATA_VOLUME" in
    '' | *[!A-Za-z0-9_.-]*) usage_error "PCP_DATA_VOLUME must be a volume name (letters, digits, '_', '.', '-'), not '$PCP_DATA_VOLUME'." ;;
  esac
  # A pinned version never changes, so there is nothing to install from PCP.
  if [ "$PCP_UPDATE_BUTTON" = 1 ] && [ "$PCP_VERSION" = latest ]; then
    WATCH=1
  else
    WATCH=0
  fi
}

usage_error() {
  warn "$@"
  exit 2
}

# A directory root reads or runs from is 0755 whatever root's umask, so an
# unusual umask leaves nothing group- or world-writable, or unreadable.
make_dir() {
  mkdir -p "$1"
  if [ "$ROOT" = 1 ]; then
    chmod 0755 "$1"
  fi
}

save_conf() {
  make_dir "$(dirname "$CONF")"
  printf 'PCP_PORT=%s\nPCP_HTTPS=%s\nPCP_RUNTIME=%s\nPCP_DATA_VOLUME=%s\nPCP_AUTO_UPDATE=%s\nPCP_UPDATE_BUTTON=%s\n' \
    "$PCP_PORT" "$PCP_HTTPS" "$RUNTIME" "$PCP_DATA_VOLUME" "$PCP_AUTO_UPDATE" "$PCP_UPDATE_BUTTON" >"$CONF"
  if [ "$ROOT" = 1 ]; then
    chmod 0644 "$CONF"
  fi
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

# Where the installer keeps its own files. As root they are in system places
# that only root writes, never under HOME or XDG_*: root runs the updater
# every day, and `sudo -E` or a sudo that keeps HOME would otherwise point
# them into a directory an ordinary user owns.
set_conf_path() {
  if [ "$ROOT" = 1 ]; then
    CONF="${PCP_ROOT_PREFIX:-}/etc/pcp/install.conf"
  else
    CONF="${XDG_CONFIG_HOME:-${HOME:?}/.config}/pcp/install.conf"
  fi
}

set_paths() {
  if [ "$ROOT" = 1 ]; then
    UNIT_DIR="${PCP_ROOT_PREFIX:-}/etc/containers/systemd"
    WANTED_BY=multi-user.target
    JOURNAL="journalctl -u $CONTAINER -f"
  else
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
    WANTED_BY=default.target
    JOURNAL="journalctl --user -u $CONTAINER -f"
  fi
  UNIT="$UNIT_DIR/$CONTAINER.container"
  LOGS="$RUNTIME logs -f $CONTAINER"
  if [ "$ROOT" = 1 ]; then
    TIMER_DIR="${PCP_ROOT_PREFIX:-}/etc/systemd/system"
    UPDATER="${PCP_ROOT_PREFIX:-}/usr/local/lib/pcp/install.sh"
    STATE_DIR="${PCP_ROOT_PREFIX:-}/var/lib/pcp"
  else
    TIMER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    UPDATER="${XDG_DATA_HOME:-$HOME/.local/share}/pcp/install.sh"
    STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pcp"
  fi
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
  # Tells PCP's Settings page that it is updated by itself.
  if [ "$PCP_AUTO_UPDATE" = 1 ]; then
    set -- "$@" -e PCP_AUTO_UPDATE=1
  fi
  # Tells it that "Install and restart" on its Settings page is watched for.
  if [ "$WATCH" = 1 ]; then
    set -- "$@" -e PCP_HOST_UPDATER=1
  fi
  "$RUNTIME" run "$@" -v "$PCP_DATA_VOLUME:/data" "$IMAGE" >/dev/null || start_failed "$LOGS"
  MODE=container
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
    # The label is what podman-auto-update.timer looks for, so it goes only
    # on a unit that asked for the daily update: the timer may be on for
    # other containers.
    if [ "$PCP_AUTO_UPDATE" = 1 ]; then
      printf 'Environment=PCP_AUTO_UPDATE=1\n'
      printf 'Label=io.containers.autoupdate=registry\n'
    fi
    if [ "$WATCH" = 1 ]; then
      printf 'Environment=PCP_HOST_UPDATER=1\n'
    fi
    printf '\n'
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
  MODE=quadlet
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

# --- Updating by itself -----------------------------------------------------

fetch_to() {
  if has curl; then
    curl -fsSL "$1" -o "$2"
  else
    wget -q -O "$2" "$1"
  fi
}

# A copy of this installer for the timers to run: the file this run came
# from, or, through a pipe, the address it is published at. Once per run.
save_updater() {
  if [ "$UPDATER_SAVED" = 1 ]; then
    return 0
  fi
  make_dir "$(dirname "$UPDATER")"
  source_file=
  case "$0" in
    */* | *.sh)
      if [ -f "$0" ]; then
        source_file=$0
      fi
      ;;
  esac
  if [ -n "$source_file" ]; then
    cp "$source_file" "$UPDATER.new"
  else
    fetch_to "$SCRIPT_URL" "$UPDATER.new"
  fi || return 1
  if [ "$ROOT" = 1 ]; then
    chmod 0644 "$UPDATER.new"
  fi
  mv "$UPDATER.new" "$UPDATER"
  UPDATER_SAVED=1
}

# The copy goes when no timer of PCP's runs it any more.
drop_updater() {
  [ "$NEEDS_UPDATER" = 1 ] && return 0
  rm -f "$UPDATER"
  if [ "$ROOT" = 1 ]; then
    rmdir "$(dirname "$UPDATER")" >/dev/null 2>&1 || true
  fi
}

write_update_timer() {
  mkdir -p "$TIMER_DIR"
  {
    printf '# Updates PCP when there is a new release. Written by install.sh;\n'
    printf '# running it with PCP_AUTO_UPDATE=0 removes it.\n'
    printf '[Unit]\nDescription=Update PCP\n\n'
    printf '[Service]\nType=oneshot\nExecStart=/bin/sh "%s" update\n' "$UPDATER"
  } >"$TIMER_DIR/pcp-update.service"
  {
    printf '# Starts pcp-update.service once a day. Written by install.sh.\n'
    printf '[Unit]\nDescription=Update PCP once a day\n\n'
    printf '[Timer]\nOnCalendar=daily\nRandomizedDelaySec=1h\nPersistent=true\n\n'
    printf '[Install]\nWantedBy=timers.target\n'
  } >"$TIMER_DIR/pcp-update.timer"
}

# Removes the timer of PCP's own, if this installer set one up.
disable_auto_update() {
  [ -f "$TIMER_DIR/pcp-update.timer" ] || return 0
  unit_ctl disable --now pcp-update.timer >/dev/null 2>&1 || true
  rm -f "$TIMER_DIR/pcp-update.timer" "$TIMER_DIR/pcp-update.service"
  drop_updater
  unit_ctl daemon-reload >/dev/null 2>&1 || true
}

# PCP_AUTO_UPDATE=1. Under Quadlet the unit's autoupdate label and Podman's
# timer do it; otherwise a daily timer runs `install.sh update`, and without
# a systemd session the owner is given the cron line.
enable_auto_update() {
  if [ "$MODE" = quadlet ]; then
    disable_auto_update
    if unit_ctl enable --now podman-auto-update.timer >/dev/null 2>&1; then
      AUTO=timer
    else
      warn "" "Could not turn on podman-auto-update.timer; run this installer again to update PCP."
    fi
    return 0
  fi
  if ! save_updater; then
    warn "" "Could not keep a copy of this installer for the daily update; run it again to update PCP."
    return 0
  fi
  if systemd_ok; then
    write_update_timer
    unit_ctl daemon-reload
    unit_ctl enable --now pcp-update.timer
    if [ "$ROOT" = 0 ]; then
      loginctl enable-linger >/dev/null 2>&1 || true
    fi
    AUTO=timer
  else
    AUTO=cron
    warn "" "There is no systemd session for this user, so the daily update needs a line in your crontab (crontab -e):" "" \
      "  0 4 * * * /bin/sh \"$UPDATER\" update"
  fi
}

# --- Installing when PCP asks -----------------------------------------------

write_request_watch() {
  mkdir -p "$TIMER_DIR"
  {
    printf '# Installs an update when you ask on PCP'"'"'s Settings page. Written by\n'
    printf '# install.sh; running it with PCP_UPDATE_BUTTON=0 removes it.\n'
    printf '[Unit]\nDescription=Install a PCP update when PCP asks\n\n'
    printf '[Service]\nType=oneshot\nExecStart=/bin/sh "%s" watch\n' "$UPDATER"
  } >"$TIMER_DIR/pcp-update-request.service"
  {
    printf '# Starts pcp-update-request.service every 30 seconds. Written by install.sh.\n'
    printf '[Unit]\nDescription=Look for a PCP update request\n\n'
    printf '[Timer]\nOnBootSec=1min\nOnUnitActiveSec=30s\nAccuracySec=5s\n\n'
    printf '[Install]\nWantedBy=timers.target\n'
  } >"$TIMER_DIR/pcp-update-request.timer"
}

# Removes the request watcher, if this installer set one up.
disable_request_watch() {
  [ -f "$TIMER_DIR/pcp-update-request.timer" ] || return 0
  unit_ctl disable --now pcp-update-request.timer >/dev/null 2>&1 || true
  rm -f "$TIMER_DIR/pcp-update-request.timer" "$TIMER_DIR/pcp-update-request.service"
  rm -f "$STATE_DIR/install-request"
  rmdir "$STATE_DIR" >/dev/null 2>&1 || true
  drop_updater
  unit_ctl daemon-reload >/dev/null 2>&1 || true
}

# PCP_UPDATE_BUTTON=1 (the default): a timer runs `install.sh watch` every
# 30 seconds; without a systemd session the owner is given the cron line.
enable_request_watch() {
  if ! save_updater; then
    warn "" "Could not keep a copy of this installer, so \"Install and restart\" in PCP will not work; run the installer again to update PCP."
    return 0
  fi
  if systemd_ok; then
    write_request_watch
    unit_ctl daemon-reload
    unit_ctl enable --now pcp-update-request.timer
    if [ "$ROOT" = 0 ]; then
      loginctl enable-linger >/dev/null 2>&1 || true
    fi
    BUTTON=timer
  else
    BUTTON=cron
    warn "" "There is no systemd session for this user, so \"Install and restart\" in PCP needs a line in your crontab (crontab -e):" "" \
      "  * * * * * /bin/sh \"$UPDATER\" watch"
  fi
}

# What the watcher runs: when the owner asked for an update on PCP's Settings
# page, PCP has left `<id> <seconds since 1970>` in /data/install-request
# (lib/core/updates/host-signal.ts). PCP wrote it, so it is checked like any
# input: a request that is not exactly that, is older than 15 minutes, was
# already answered, or comes within 5 minutes of the last one does nothing.
# The id is noted before `update` runs, so a failed one is not retried.
watch() {
  [ "$WATCH" = 1 ] || return 0
  container_running || return 0
  signal=$("$RUNTIME" exec "$CONTAINER" cat /data/install-request 2>/dev/null) || return 0
  id=${signal%% *}
  at=${signal#* }
  case "$id" in
    '' | *[!0-9a-f-]*) return 0 ;;
  esac
  case "$at" in
    '' | *[!0-9]*) return 0 ;;
  esac
  [ "${#id}" -eq 36 ] && [ "${#at}" -le 12 ] || return 0
  now=$(date +%s)
  [ "$at" -le $((now + 60)) ] && [ $((now - at)) -le 900 ] || return 0

  handled="$STATE_DIR/install-request"
  last_id=
  last_at=0
  if [ -f "$handled" ]; then
    read -r last_id last_at <"$handled" || true
  fi
  case "$last_at" in
    '' | *[!0-9]*) last_at=0 ;;
  esac
  [ "$id" != "$last_id" ] && [ $((now - last_at)) -ge 300 ] || return 0

  make_dir "$STATE_DIR"
  printf '%s %s\n' "$id" "$now" >"$handled"
  say "PCP asked for an update."
  update
}

image_id() {
  "$RUNTIME" image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true
}

# What the daily timer runs: fetch the image, and start PCP again only when
# there is a new one (or PCP is not running).
update() {
  UPDATING=1
  before=$(image_id)
  "$RUNTIME" pull -q "$IMAGE" >/dev/null || die "Could not pull $IMAGE. Check that this computer reaches ghcr.io."
  after=$(image_id)
  if [ -n "$after" ] && [ "$before" = "$after" ] && container_running; then
    say "PCP is up to date: $IMAGE has not changed."
    return 0
  fi
  install
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
  case "$AUTO" in
    timer) updates="  Update PCP   by itself, once a day (PCP_AUTO_UPDATE=0 turns it off)" ;;
    cron) updates="  Update PCP   with the crontab line above, or run this installer again" ;;
    *) updates="  Update PCP   run this installer again (PCP_AUTO_UPDATE=1 does it daily)" ;;
  esac
  case "$BUTTON" in
    timer) updates="$updates
               or \"Install and restart\" under Settings in PCP" ;;
    cron) updates="$updates
               or \"Install and restart\" in PCP, with its crontab line above" ;;
  esac
  say "" \
    "Open it now and set up your vault: the first person to open it becomes" \
    "its owner." "" \
    "$updates" \
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
  if [ "$UPDATING" = 1 ]; then
    say "PCP is updated: $IMAGE."
    return 0
  fi
  # The copy of this installer stays while a timer of PCP's runs it.
  NEEDS_UPDATER=$WATCH
  if [ "$PCP_AUTO_UPDATE" = 1 ] && [ "$MODE" != quadlet ]; then
    NEEDS_UPDATER=1
  fi
  if [ "$PCP_AUTO_UPDATE" = 1 ]; then
    enable_auto_update
  else
    disable_auto_update
  fi
  if [ "$WATCH" = 1 ]; then
    enable_request_watch
  else
    disable_request_watch
  fi
  summary
}

uninstall() {
  if [ "$RUNTIME" = podman ] && [ -f "$UNIT" ]; then
    unit_ctl stop "$CONTAINER.service" >/dev/null 2>&1 || true
    rm -f "$UNIT"
    unit_ctl daemon-reload >/dev/null 2>&1 || true
  fi
  "$RUNTIME" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  disable_auto_update
  disable_request_watch
  rm -f "$CONF"
  if [ "$ROOT" = 1 ]; then
    rmdir "$(dirname "$CONF")" >/dev/null 2>&1 || true
  fi
  say "PCP is removed. The $PCP_DATA_VOLUME volume, with your vault, is kept. To delete it too:" "" \
    "  $RUNTIME volume rm $PCP_DATA_VOLUME"
}

main() {
  case "${1:-}" in
    '' | uninstall | update | watch) ;;
    *) usage ;;
  esac
  require_linux
  if [ "$(id -u)" = 0 ]; then
    ROOT=1
  else
    ROOT=0
  fi
  set_conf_path
  # Only an install run may carry settings over from HOME.
  case "${1:-}" in
    '') MIGRATE=1 ;;
    *) MIGRATE=0 ;;
  esac
  resolve_settings
  pick_runtime
  set_paths
  MODE=
  AUTO=
  BUTTON=
  UPDATING=0
  UPDATER_SAVED=0
  NEEDS_UPDATER=0
  case "${1:-}" in
    uninstall) uninstall ;;
    update) update ;;
    watch) watch ;;
    *) install ;;
  esac
}

main "$@"
