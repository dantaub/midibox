# 🎹 MidiBox

An always-on MIDI recording service that captures every note played on your keyboard, letting you save, label, and play back your practice sessions.

## Overview

MidiBox runs as a background service on a small computer (like an Alpine Linux box) connected to your MIDI keyboard. It continuously records all MIDI events to a local SQLite database, providing:

- **Real-time visualization** of notes as they're played on a virtual piano
- **Session labeling** via a mobile-friendly web interface
- **Playback** of recorded sessions back to the keyboard
- **MIDI file import** to play standard `.mid` files on your keyboard

Perfect for musicians who want to capture spontaneous practice moments without remembering to hit "record."

## Current Features

### ✅ Implemented

- **Continuous MIDI capture** from raw MIDI devices (`/dev/snd/midiC*D*`)
- **SQLite storage** using Bun's built-in `bun:sqlite` for efficient event storage
- **Web UI** (port 4000) with:
  - Live 88-key piano visualization (A0-C8)
  - Real-time event log showing notes, velocities, and control changes
  - Session management (save/load named sessions with performer and song info)
  - MIDI output selection for playback
  - Click/touch-to-play keys (plays notes on the keyboard)
  - MIDI file upload and playback
  - Playback progress bar with green key highlighting
- **TUI client** for HDMI-connected displays (connects via WebSocket)
- **OpenRC service scripts** for Alpine Linux deployment
- **WebSocket streaming** for real-time updates to all connected clients

### 🚧 Planned Features

- **Automatic song detection** - Analyze gaps in playing to automatically identify when songs start and end
- **Timeline visualization** - Visual waveform/piano roll view of recorded data showing note density over time
- **Timeline scrubbing** - Navigate through hours of recorded data with a visual scrubber
- **Manual session selection** - Draw on the timeline to select time spans for marking as sessions
- **Smart segmentation** - AI-assisted suggestions for song boundaries based on tempo, key changes, and pauses
- **Export options** - Export sessions as MIDI files or audio
- **Quantization** - Snap recorded notes to a grid (1/4, 1/8, 1/16 notes, etc.) to clean up timing
- **Sheet music PDF generation** - Quantize recordings and generate printable PDF sheet music with proper notation

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **Database:** SQLite via `bun:sqlite`
- **MIDI:** Raw device access (`/dev/snd/midi*`)
- **Frontend:** Vanilla HTML/CSS/JS with WebSocket
- **Target OS:** Alpine Linux with OpenRC

## Installation

```bash
# Clone the repository
git clone https://github.com/creationix/midibox.git
cd midibox

# Install dependencies
bun install

# Start the server
bun run start
```

## Usage

1. Connect your MIDI keyboard
2. Start the MidiBox server: `bun run start`
3. Open `http://localhost:4000` in a browser
4. Play your keyboard - notes appear on the virtual piano in real-time
5. Use the session panel to save and label recordings

### Service Installation (Alpine Linux)

```bash
# Copy service scripts
sudo cp scripts/midibox /etc/init.d/
sudo chmod +x /etc/init.d/midibox

# Enable and start
sudo rc-update add midibox default
sudo rc-service midibox start
```

## API Endpoints

| Method | Endpoint                        | Description                    |
| ------ | ------------------------------- | ------------------------------ |
| GET    | `/api/events/recent?minutes=5`  | Get recent MIDI events         |
| GET    | `/api/events/range?start=&end=` | Get events in time range       |
| GET    | `/api/sessions`                 | List all sessions              |
| POST   | `/api/sessions`                 | Create a new session           |
| GET    | `/api/midi/inputs`              | List MIDI input devices        |
| GET    | `/api/midi/outputs`             | List MIDI output devices       |
| POST   | `/api/playback/start`           | Start session playback         |
| POST   | `/api/playback/stop`            | Stop playback                  |
| POST   | `/api/playback/file`            | Upload and play MIDI file      |
| WS     | `/ws`                           | WebSocket for real-time events |

## License

MIT
