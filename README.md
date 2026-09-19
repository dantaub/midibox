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
- **Web UI** (port 4000) with two tabs:
  - **Live** - 88-key piano visualization (A0-C8) above a vertical timeline: time
    scrolls downward (or upward - the direction flips from the timeline controls)
    while pitch runs across, lined up with the keys above
  - A **Live** toggle in the header follows the present and keeps refreshing;
    switch it off to freeze the view, or hit Refresh to re-read the window
  - The live update rate is a note length (1/1 down to 1/16, dotted and triplet)
    at a tempo set by a 40-220 BPM slider
  - **History** - recorded activity grouped by date, split into stretches of
    playing, with sparklines, per-stretch playback, and save-as-session
  - Lettered recording banks (A-L, or untagged) that tag incoming notes, with a
    matching bank filter on the History tab
  - Event log as a draggable floating window, toggled from the header
  - Session management (save/load named sessions with performer and song info)
  - MIDI output selection for playback
  - Click/touch-to-play keys (plays notes on the keyboard)
  - MIDI file upload and playback
  - Playback progress bar with green key highlighting
- **TUI client** for HDMI-connected displays (connects via WebSocket)
- **Service scripts** for systemd and OpenRC (Alpine) deployment
- **WebSocket streaming** for real-time updates to all connected clients

### 🚧 Planned Features

- **Automatic song detection** - Name and label the stretches the History tab already detects
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

### Banks and history

Pick a bank (A-L) in the **Recording Bank** panel on the Live tab and every note
captured from then on is tagged with that letter; leave it on *All (untagged)* to
record without a tag. The **History** tab lists what was played by date, splits
each day into stretches of continuous playing, and filters all of it by bank.

The bank tag is an added, nullable column on `midi_events` and `sessions`: older
databases are migrated in place on startup, rows recorded before banks existed
read as untagged, and clients that don't send a bank keep working unchanged.

### Service Installation

```bash
./scripts/install-service.sh
```

The installer detects the init system, fills in your install directory, user and
`bun` path, adds the user to the `audio` group, and enables the service.

**systemd** (most distros) installs `/etc/systemd/system/midibox.service`:

```bash
sudo systemctl restart midibox
systemctl status midibox
journalctl -u midibox -f        # logs
```

Settings live in `/etc/default/midibox` (e.g. `MIDIBOX_PORT=4000`).

If you previously copied `scripts/midibox.initd` into `/etc/init.d/` on a systemd
host, remove it — systemd wraps leftover SysV scripts with its deprecated
compatibility generator, which is what logs *"lacks a native systemd unit file"*
at boot and shadows the real unit:

```bash
sudo rm /etc/init.d/midibox
sudo systemctl daemon-reload
```

**OpenRC** (Alpine) installs `/etc/init.d/midibox` with settings in
`/etc/conf.d/midibox`:

```bash
sudo rc-service midibox start
sudo rc-service midibox status  # logs: /var/log/midibox.log
```

## API Endpoints

| Method | Endpoint                               | Description                                |
| ------ | -------------------------------------- | ------------------------------------------ |
| GET    | `/api/events/recent?minutes=5&bank=`   | Get recent MIDI events                     |
| GET    | `/api/events/range?start=&end=&bank=`  | Get events in time range                   |
| GET    | `/api/bank`                            | Current recording bank + available banks   |
| POST   | `/api/bank`                            | Set the bank new notes are tagged with     |
| GET    | `/api/history/days?tz=&bank=`          | Per-day activity totals, newest first      |
| GET    | `/api/history/segments?start=&end=`    | Stretches of activity (plus sessions)      |
| GET    | `/api/sessions`                        | List all sessions                          |
| POST   | `/api/sessions`                        | Create a new session                       |
| GET    | `/api/midi/inputs`                     | List MIDI input devices                    |
| GET    | `/api/midi/outputs`                    | List MIDI output devices                   |
| GET    | `/api/midi/output`                     | Currently connected output                 |
| POST   | `/api/midi/output`                     | Connect an output (without playing)        |
| DELETE | `/api/midi/output`                     | Disconnect the output                      |
| POST   | `/api/playback/start`                  | Start session playback                     |
| POST   | `/api/playback/stop`                   | Stop playback                              |
| POST   | `/api/playback/file`                   | Upload and play MIDI file                  |
| WS     | `/ws`                                  | WebSocket for real-time events             |

## License

MIT
