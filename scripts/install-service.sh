#!/bin/sh
# Install MidiBox as a service - systemd (most distros) or OpenRC (Alpine).
#
#   install-service.sh            install, refusing if already installed
#   install-service.sh --force    reinstall over an existing installation
#   install-service.sh --help

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIDIBOX_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

FORCE=""
case "${1:-}" in
    -f|--force)
        FORCE=1
        ;;
    -h|--help)
        sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    "")
        ;;
    *)
        echo "Unknown option: $1 (try --help)" >&2
        exit 2
        ;;
esac

# ---------------------------------------------------------------
# How to drive the service once it is installed. Printed after a
# successful install, and when one is already there.
# ---------------------------------------------------------------
usage_systemd() {
    cat <<EOF
Commands:
  sudo systemctl start midibox    # Start the service
  sudo systemctl stop midibox     # Stop the service
  sudo systemctl restart midibox  # Restart the service
  systemctl status midibox        # Check status

Logs: journalctl -u midibox -f
Config: /etc/default/midibox (e.g. MIDIBOX_PORT), unit at $SYSTEMD_UNIT
EOF
}

usage_openrc() {
    cat <<EOF
Commands:
  sudo rc-service midibox start    # Start the service
  sudo rc-service midibox stop     # Stop the service
  sudo rc-service midibox restart  # Restart the service
  sudo rc-service midibox status   # Check status

Logs: /var/log/midibox.log
Config: /etc/conf.d/midibox, init script at $OPENRC_SCRIPT
EOF
}

SYSTEMD_UNIT=/etc/systemd/system/midibox.service
OPENRC_SCRIPT=/etc/init.d/midibox

# ---------------------------------------------------------------
# Which init system, and is MidiBox already installed under it?
# ---------------------------------------------------------------
if [ -d /run/systemd/system ]; then
    INIT=systemd
elif command -v rc-update >/dev/null 2>&1; then
    INIT=openrc
else
    echo "Neither systemd nor OpenRC detected - install the service manually." >&2
    exit 1
fi

if [ -z "$FORCE" ]; then
    if [ "$INIT" = systemd ] && [ -f "$SYSTEMD_UNIT" ]; then
        echo "MidiBox is already installed as a systemd service ($SYSTEMD_UNIT)." >&2
        echo "" >&2
        usage_systemd >&2
        echo "" >&2
        echo "Re-run with --force to overwrite the unit (your /etc/default/midibox is kept)." >&2
        exit 1
    fi
    if [ "$INIT" = openrc ] && [ -f "$OPENRC_SCRIPT" ]; then
        echo "MidiBox is already installed as an OpenRC service ($OPENRC_SCRIPT)." >&2
        echo "" >&2
        usage_openrc >&2
        echo "" >&2
        echo "Re-run with --force to overwrite the init script (your /etc/conf.d/midibox is kept)." >&2
        exit 1
    fi
fi

# Run as the invoking user, not root, when called through sudo
MIDIBOX_USER="${SUDO_USER:-$(id -un)}"

# Where bun lives for that user (the service has no PATH from your shell)
MIDIBOX_BUN="${MIDIBOX_BUN:-$(command -v bun || true)}"
if [ -z "$MIDIBOX_BUN" ]; then
    MIDIBOX_BUN="$(eval echo "~$MIDIBOX_USER")/.bun/bin/bun"
fi
if [ ! -x "$MIDIBOX_BUN" ]; then
    echo "Could not find the bun binary (looked for: $MIDIBOX_BUN)." >&2
    echo "Install bun first, or set MIDIBOX_BUN=/path/to/bun and re-run." >&2
    exit 1
fi

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

[ -n "$FORCE" ] && echo "Reinstalling MidiBox service..." || echo "Installing MidiBox service..."
echo "  init:      $INIT"
echo "  directory: $MIDIBOX_DIR"
echo "  user:      $MIDIBOX_USER"
echo "  bun:       $MIDIBOX_BUN"

# Make sure the service user can reach /dev/snd
if ! id -nG "$MIDIBOX_USER" | tr ' ' '\n' | grep -qx audio; then
    echo "Adding $MIDIBOX_USER to the audio group..."
    if command -v usermod >/dev/null 2>&1; then
        $SUDO usermod -aG audio "$MIDIBOX_USER"
    elif command -v addgroup >/dev/null 2>&1; then
        $SUDO addgroup "$MIDIBOX_USER" audio
    else
        echo "Could not add $MIDIBOX_USER to the audio group - do it manually." >&2
    fi
    echo "Log out and back in (or reboot) for the group change to take effect."
fi

if [ "$INIT" = systemd ]; then
    # ---------------------------------------------------------------
    # systemd
    # ---------------------------------------------------------------
    sed -e "s|@MIDIBOX_USER@|$MIDIBOX_USER|g" \
        -e "s|@MIDIBOX_DIR@|$MIDIBOX_DIR|g" \
        -e "s|@MIDIBOX_BUN@|$MIDIBOX_BUN|g" \
        "$SCRIPT_DIR/midibox.service" | $SUDO tee "$SYSTEMD_UNIT" >/dev/null

    [ -f /etc/default/midibox ] || $SUDO cp "$SCRIPT_DIR/midibox.default" /etc/default/midibox

    # An OpenRC script left in /etc/init.d makes systemd generate a compat unit
    # ("lacks a native systemd unit file") that shadows this one.
    if [ -f "$OPENRC_SCRIPT" ]; then
        echo ""
        echo "Found the OpenRC script at $OPENRC_SCRIPT."
        echo "systemd wraps it with its deprecated SysV compatibility generator,"
        echo "so it should go now that a native unit is installed."
        if [ -t 0 ]; then
            printf "Remove %s? [Y/n] " "$OPENRC_SCRIPT"
            read -r reply
            case "$reply" in
                [Nn]*) echo "Left in place - remove it yourself to silence the warning." ;;
                *) $SUDO rm -f "$OPENRC_SCRIPT"; echo "Removed." ;;
            esac
        else
            echo "Run: sudo rm $OPENRC_SCRIPT"
        fi
    fi

    $SUDO systemctl daemon-reload
    $SUDO systemctl enable midibox
    $SUDO systemctl restart midibox

    echo ""
    echo "MidiBox service installed!"
    echo ""
    usage_systemd
else
    # ---------------------------------------------------------------
    # OpenRC (Alpine)
    # ---------------------------------------------------------------
    $SUDO cp "$SCRIPT_DIR/midibox.initd" "$OPENRC_SCRIPT"
    $SUDO chmod +x "$OPENRC_SCRIPT"

    if [ -f /etc/conf.d/midibox ]; then
        echo "Keeping existing /etc/conf.d/midibox"
    else
        sed -e "s|^MIDIBOX_DIR=.*|MIDIBOX_DIR=\"$MIDIBOX_DIR\"|" \
            -e "s|^MIDIBOX_USER=.*|MIDIBOX_USER=\"$MIDIBOX_USER\"|" \
            -e "s|^MIDIBOX_BUN=.*|MIDIBOX_BUN=\"$MIDIBOX_BUN\"|" \
            "$SCRIPT_DIR/midibox.confd" | $SUDO tee /etc/conf.d/midibox >/dev/null
    fi

    $SUDO rc-update add midibox default

    echo ""
    echo "MidiBox service installed!"
    echo ""
    usage_openrc
fi

echo ""
echo "TUI client: bun run tui"
echo "Web client: http://localhost:4000"
