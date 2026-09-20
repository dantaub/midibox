# How MidiBox works

A single Bun process. It reads a MIDI device, writes every event to SQLite,
and serves the UI. No build step, no framework, no external database.

```
MIDI keyboard / network
     │  ALSA seq · raw /dev/snd · CoreMIDI · RTP-MIDI  (src/transports/*)
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
| `src/midi.ts` | Transport coordinator: selection, capture pipeline, thru, output |
| `src/transports/` | One file per MIDI transport behind a shared interface |
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

## Transports

Device I/O lives behind a small `MidiTransport` interface
(`src/transports/types.ts`): `listInputs/Outputs`, `openInput/openOutput`,
`send`, `closeInput/closeOutput`. `src/midi.ts` is the coordinator — it picks a
transport by address **scheme** and funnels every captured message through one
pipeline (thru → parse → store → broadcast), so `server.ts` and the UI never
learn which backend is in use.

| Scheme | Backend | Notes |
| ------ | ------- | ----- |
| `seq` | ALSA seq / CoreMIDI / WinMM via RtMidi (`@julusian/midi`) | **Linux default.** Ports addressed by stable name, resolved to the current index at open time; a PipeWire graph can share the port |
| `rawalsa` | Raw `/dev/snd/midiC*D*` (`cat` in, `Bun.write` out) | The original path; single-reader, index-addressed. Auto-fallback on Linux |
| `coremidi` | CoreMIDI via JZZ | **macOS default** |
| `rtp` / `rtpm` | RTP-MIDI over UDP (`node:dgram`) | Unicast / multicast; interops with qmidinet/multimidicast |

An address is `<scheme>:<rest>` (`seq:USB Keyboard MIDI 1`,
`rtpm:225.0.0.37:21928`); a bare id uses the platform default scheme. The
default is chosen per OS and overridable with `MIDIBOX_MIDI`. On Linux, if the
default `seq` transport finds no ports or fails to open, capture **auto-falls
back to `rawalsa`** (unless a scheme was pinned explicitly).

Each scheme has one cached instance holding an input and an output handle
independently. **Thru** gets its own fresh instance so it never fights the
playback output for the single output handle; when enabled, incoming bytes are
forwarded before parsing.

Opening a `rawalsa` output probes the device first with an Active Sensing byte
(`0xFE`), which synths ignore, so permission problems surface at connect time.
One output device is open at a time, opened explicitly (`POST /api/midi/output`)
rather than as a side effect of playing something.

## Playback

`runTimedPlayback()` is the shared scheduler. It sleeps until the next event's
offset, then **drains every event now due** (plus a 2 ms look-ahead) into one
batch. Audio timing is the priority, so the whole batch is sent to the MIDI
device **before** any WebSocket work — serialization never sits between two note
sends, and a chord's notes go out back-to-back on one wake-up instead of on
separate timer ticks. The WebSocket `playback-event` feed is visual-only and
tolerant to tens of ms, so it follows the audio. Sleeping recomputes against
absolute time, so lateness never accumulates; an `AbortController` makes stop
immediate. `playbackEvents()` (recorded range) and `playbackMidiFile()` (parsed
file, ms offsets) both drive this scheduler.

Scheduling accuracy is logged at the end of each playback — average and max
lateness across batches — and `MIDIBOX_PLAYBACK_DEBUG=1` adds a per-batch line.
On a quiet event loop this runs well under a millisecond of jitter. (`setTimeout`
in a single JS thread is the floor here; a worker thread with a high-res clock
would be the next step if that ever isn't tight enough.)

The browser doesn't schedule anything itself — it calibrates its playhead from
the timestamps the server sends, so the line on screen tracks what the device is
actually playing.

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

## Tests

```bash
bun test              # storage + API (fast, no browser)
bun run test:ui       # browser tests, needs Chromium
bun run test:all      # everything
```

| Suite | Covers |
| ----- | ------ |
| `test/db.test.ts` | Event round-trips, range and cutoff queries, session CRUD, overlap matching, segment splitting and summaries, day grouping across timezones |
| `test/api.test.ts` | Every endpoint's shape, 404s, output connect failures, static files, the WebSocket ping |
| `test/ui.test.ts` | Keyboard/timeline alignment at four widths, live mode issuing no requests, redraw cadence at both rates, the direction flip and its persistence, control swapping, nothing clipped at phone/tablet/desktop sizes, fullscreen |

Both server suites run against a throwaway database — `test/setup.ts` points
`MIDIBOX_DB` at a temp directory, so they never touch your recordings. The UI
suite starts its own server on a random port and fails on any console or page
error, which is what catches most regressions.

The browser tests need a Chromium build. `bunx playwright install chromium`
provides one; otherwise set `CHROMIUM_PATH`. Without either they skip rather
than fail, so `bun run test:all` works on a machine with no browser.

## Gotchas

- **`Bun.write(path)` truncates.** Fine for a character device, wrong for a
  regular file — worth remembering if the output path is ever misconfigured.
- **Canvases can't be measured while hidden.** Switching tabs re-sizes them.
- **`localStorage` writes are deduplicated** before saving the view state,
  because the redraw path touches it and 60 Hz would mean 60 writes a second.
- **The database grows forever.** Roughly 50 MB per million events (measured at
  47 bytes each); there is no pruning yet.
- **Capture writes synchronously on the event loop.** One fsynced insert per
  event; with the default rollback journal on an SD card that stalled 50-140 ms
  per event and inflated chord timing. The DB now opens in WAL with
  `synchronous=NORMAL` (src/db.ts) to keep inserts sub-millisecond. If capture
  ever needs to scale further, batch the inserts or move them off the hot path.
- **A "chord" is never simultaneous.** MIDI is serial — each 3-byte note-on
  takes ~1 ms on a DIN link, so chord notes arrive a millisecond or so apart by
  protocol, before any software. On top of that, capture timestamps with
  `Date.now()` (1 ms granularity), so near-simultaneous notes can land on
  different milliseconds. `bun run midi:timing` (`scripts/midi-timing.ts`)
  measures the split: RtMidi's `deltaTime` is the protocol/driver floor, a
  high-res clock in the callback shows software-added latency, and the
  `Date.now()` delta shows the recording granularity.
