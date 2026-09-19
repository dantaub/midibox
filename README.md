# 🎹 MidiBox

An always-on MIDI recording service that captures every note played on your
keyboard, so you can find, label and play back the things you didn't think to
record.

MidiBox runs as a background service on a small computer connected to your MIDI
keyboard — an Alpine box, a Pi, a spare laptop. It records continuously to a
local SQLite file and serves a web UI for browsing what it caught.

```bash
git clone https://github.com/creationix/midibox.git
cd midibox && bun install && bun run start
```

Then open <http://localhost:4000> and play.

## Documentation

- **[INSTALL.md](INSTALL.md)** — requirements, running it as a service
  (systemd, user units, OpenRC), ports, directories, backups, troubleshooting
- **[USAGE.md](USAGE.md)** — the web UI, timeline, sessions, history, shortcuts
- **[API.md](API.md)** — HTTP endpoints and the WebSocket protocol
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the pieces fit, for anyone
  changing the code

## What it does

- **Records continuously** from a raw ALSA device (Linux) or CoreMIDI (macOS)
  to SQLite — no record button to forget
- **Live view** — an 88-key keyboard above a vertical timeline that shares its
  pitch axis, following the present at a note length and tempo of your choosing
  (or 60 Hz), and freezing for pan, zoom and selection
- **History** — everything by date, split into stretches of continuous playing
  with sparklines, previews and one-click labelling
- **Sessions** — name a span as a song and performer; edit its bounds later by
  dragging on the timeline
- **Playback** to the keyboard, with the notes lit up as they play
- **MIDI thru**, click-to-play keys, and standard `.mid` file playback
- **TUI client** for a screen attached to the box itself
- **Tablet-friendly** — a fullscreen mode, touch gestures, and an installable
  home-screen app on iPad

## Planned

- **Automatic song detection** — name and label the stretches history already finds
- **Smart segmentation** — suggestions for song boundaries from tempo, key and pauses
- **Export** sessions as MIDI or audio
- **Quantization** — snap recorded notes to a grid
- **Sheet music PDFs** from quantized recordings

## Tech

Bun, `bun:sqlite`, raw `/dev/snd` access, and vanilla HTML/CSS/JS over a
WebSocket. No build step.

## License

MIT
