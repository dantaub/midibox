#!/bin/sh
# Install MidiBox as a service - systemd (most distros) or OpenRC (Alpine).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIDIBOX_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Run as the invoking user, not root, when called through sudo
MIDIBOX_USER="${SUDO_USER:-$(id -un)}"

# Where bun lives for that user (systemd has no PATH from your shell)
MIDIBOX_BUN="$(command -v bun || true)"
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

echo "Installing MidiBox service..."
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

if [ -d /run/systemd/system ]; then
    # ---------------------------------------------------------------
    # systemd
    # ---------------------------------------------------------------
    sed -e "s|@MIDIBOX_USER@|$MIDIBOX_USER|g" \
        -e "s|@MIDIBOX_DIR@|$MIDIBOX_DIR|g" \
        -e "s|@MIDIBOX_BUN@|$MIDIBOX_BUN|g" \
        "$SCRIPT_DIR/midibox.service" | $SUDO tee /etc/systemd/system/midibox.service >/dev/null

    [ -f /etc/default/midibox ] || $SUDO cp "$SCRIPT_DIR/midibox.default" /etc/default/midibox

    # An OpenRC script left in /etc/init.d makes systemd generate a compat unit
    # ("lacks a native systemd unit file") that shadows this one.
    if [ -f /etc/init.d/midibox ]; then
        echo ""
        echo "Found the OpenRC script at /etc/init.d/midibox."
        echo "systemd wraps it with its deprecated SysV compatibility generator,"
        echo "so it should go now that a native unit is installed."
        if [ -t 0 ]; then
            printf "Remove /etc/init.d/midibox? [Y/n] "
            read -r reply
            case "$reply" in
                [Nn]*) echo "Left in place - remove it yourself to silence the warning." ;;
                *) $SUDO rm -f /etc/init.d/midibox; echo "Removed." ;;
            esac
        else
            echo "Run: sudo rm /etc/init.d/midibox"
        fi
    fi

    $SUDO systemctl daemon-reload
    $SUDO systemctl enable midibox
    $SUDO systemctl restart midibox

    echo ""
    echo "MidiBox service installed!"
    echo ""
    echo "Commands:"
    echo "  sudo systemctl start midibox    # Start the service"
    echo "  sudo systemctl stop midibox     # Stop the service"
    echo "  sudo systemctl restart midibox  # Restart the service"
    echo "  systemctl status midibox        # Check status"
    echo ""
    echo "Logs: journalctl -u midibox -f"
    echo "Config: /etc/default/midibox (e.g. MIDIBOX_PORT)"
elif command -v rc-update >/dev/null 2>&1; then
    # ---------------------------------------------------------------
    # OpenRC (Alpine)
    # ---------------------------------------------------------------
    $SUDO cp "$SCRIPT_DIR/midibox.initd" /etc/init.d/midibox
    $SUDO chmod +x /etc/init.d/midibox

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
    echo "Commands:"
    echo "  sudo rc-service midibox start    # Start the service"
    echo "  sudo rc-service midibox stop     # Stop the service"
    echo "  sudo rc-service midibox restart  # Restart the service"
    echo "  sudo rc-service midibox status   # Check status"
    echo ""
    echo "Logs: /var/log/midibox.log"
    echo "Config: /etc/conf.d/midibox"
else
    echo "Neither systemd nor OpenRC detected - install the service manually." >&2
    exit 1
fi

echo ""
echo "TUI client: bun run tui"
echo "Web client: http://localhost:4000"
