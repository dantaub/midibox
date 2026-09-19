# How MidiBox works

A single Bun process. It reads a MIDI device, writes every event to SQLite,
and serves the UI. No build step, no framework, no external database.

```
MIDI keyboard
     │  /dev/snd/midiC0D0 (Linux)  ·  CoreMIDI via JZZ (macOS)
     ▼
  src/midi.ts ──────► src/db.ts ──────► midibox.db
     │  parsed events        insert
     │
     ├─► thru ──► MIDI output (optional)
     │
     ▼
  src/server.ts ──► WebSocket ──► browser (public/) and TUI
                └─► HTTP API ───► browser
```

## Files

| Path | What lives there |
| ---- | ---------------- |
| `index.ts` | Entry point; re-exports the server |
| `src/server.ts` | HTTP routes, WebSocket, playback scheduling |
| `src/midi.ts` | Device discovery, capture, thru, output |
| `src/db.ts` | Schema, migrations, queries, history aggregation |
| `src/midi-file.ts` | Standard MIDI file parser (format 0 and 1) |
| `src/tui.ts` | Terminal client; talks to the same WebSocket |
| `public/index.html` | The whole UI's markup |
| `public/app.js` | Keyboard, timeline, sessions, playback, output |
| `public/history.js` | Tabs and the History view |
| `public/style.css` | All styling |
| `scripts/` | systemd and OpenRC service files, installer |

`public/history.js` loads after `app.js` and reuses its top-level functions
(`$`, `isNoteOn`, `noteName`, `timeline`, `onLiveEvent`, …). They are plain
classic scripts sharing one global scope — no modules, no bundler.

## Data model

Two tables, created on first run.

```sql
midi_events(id, timestamp, channel, type, note, velocity, control, value, data)
sessions(id, start_time, end_time, performer, song_name, created_at)
```

`midi_events` is append-only and indexed on `timestamp`; every query is a range
scan over it. A session is just a labelled time span — it stores no events, so
editing its bounds re-interprets whatever was recorded then.

Migrations run at startup in `src/db.ts`, guarded so they are safe to re-run.

## Capture

**Linux** spawns `cat /dev/snd/midiC0D0` and parses the byte stream, handling
running status and variable message lengths. **macOS** opens a CoreMIDI port
through JZZ. Either way each message becomes an event that is written to SQLite
and handed to listeners; the server broadcasts it to every WebSocket client.

Raw MIDI devices allow one reader; a second process opening the same device for
input will fail while MidiBox holds it.

## Output

One output device at a time, opened explicitly (`POST /api/midi/output`) rather
than as a side effect of playing something. On Linux, sending is a `Bun.write()`
to the device path; failures are caught and logged rather than left as unhandled
rejections. Opening probes the device first with an Active Sensing byte (`0xFE`),
which synths ignore, so permission problems surface at connect time.

**Thru** is separate: when enabled, incoming bytes are forwarded to the output
as they arrive, before parsing.

## Playback

`playbackEvents()` walks the range and `await`s until each event's offset from
the first one, then sends it to the device and broadcasts a `playback-event`.
The browser doesn't schedule anything itself — it calibrates its playhead from
the timestamps the server sends, so the line on screen tracks what the
keyboard is actually playing. An `AbortController` makes stop immediate.

MIDI files take a parallel path: parsed to a flat event list with millisecond
offsets (tempo changes applied during the merge), then played the same way. All
tracks are merged, which suits formats 0 and 1; format 2 files parse but their
independent sequences are flattened into one, which isn't what format 2 means.

## History

`getActivitySegments()` reads a range and splits it wherever consecutive events
are more than `gap` apart, summarising each run: counts, pitch range, average
velocity, and note-on density in 48 buckets for the sparkline. Day grouping is
done in SQL with `strftime` against the client's timezone offset, so days break
at the viewer's local midnight rather than the server's.

## The live view

The timeline draws from `timeline.events`, a cache in the browser. It is filled
once from `/api/events/range` and then **only** extended by WebSocket events —
live mode makes no HTTP requests at all. Events that scroll far past the view
are pruned to bound memory.

Redraws are driven either by a timer at the chosen note length and tempo, or by
`requestAnimationFrame` when 60 Hz is on. Both are pure canvas work.

Pitch maps to x through `noteToX()`: 52 white-key columns with black keys
straddling them at the same fractions the CSS uses, so the canvas and the
on-screen keyboard line up to within a pixel at any width. Time maps to y, or to
`height - y` when the direction is flipped — every drawing and hit-testing path
goes through that one mapping.

## Gotchas

- **`Bun.write(path)` truncates.** Fine for a character device, wrong for a
  regular file — worth remembering if the output path is ever misconfigured.
- **Canvases can't be measured while hidden.** Switching tabs re-sizes them.
- **`localStorage` writes are deduplicated** before saving the view state,
  because the redraw path touches it and 60 Hz would mean 60 writes a second.
- **The database grows forever.** Roughly 50 MB per million events (measured at
  47 bytes each); there is no pruning yet.
