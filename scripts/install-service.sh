#!/bin/sh
# Install MidiBox as an OpenRC service on Alpine Linux

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing MidiBox service..."

# Copy init script
sudo cp "$SCRIPT_DIR/midibox.initd" /etc/init.d/midibox
sudo chmod +x /etc/init.d/midibox

# Copy config
sudo cp "$SCRIPT_DIR/midibox.confd" /etc/conf.d/midibox

# Add current user to audio group if not already
if ! groups "$USER" | grep -q audio; then
    echo "Adding $USER to audio group..."
    sudo addgroup "$USER" audio
    echo "You may need to log out and back in for group changes to take effect."
fi

# Enable service to start on boot
sudo rc-update add midibox default

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
echo ""
echo "TUI client: bun run tui"
echo "Web client: http://localhost:4000"
