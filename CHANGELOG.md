# Changelog

## Unreleased

### Upgrading

Two things need attention on an existing install:

- **Reinstall the service** to pick up the new unit:
  `./scripts/install-service.sh --force`. Without it you keep the old unit,
  which can't bind ports below 1024 and lacks the restart policy changes.
- **The first start migrates the database, one way.** It drops the `bank`
  columns added by an earlier version, the index on one of them, and the
  `settings` table. Nothing reads them any more, but take a backup first if you
  want the option of going back: `cp midibox.db midibox-backup.db`.
- **The database now runs in WAL mode** (set automatically on first open). Two
  sidecar files appear next to it, `midibox.db-wal` and `midibox.db-shm`. To
  back up, prefer `sqlite3 midibox.db ".backup ..."`, or stop the service first
  so the WAL is checkpointed before you `cp`.

### Fixed

- **Chords no longer record/play back arpeggiated.** Capture wrote each event
  with a synchronous, fully-fsynced SQLite insert; on an SD card that stalled
  the event loop 50-140 ms per event, so a chord's notes were timestamped tens
  of ms apart even though they arrived ~5 ms apart. Switching to WAL +
  `synchronous=NORMAL` cuts per-insert latency to sub-millisecond, so recorded
  (and therefore replayed and drawn) timing matches what was played.

### Added

- **Sustain pedal in the Live view.** A **Ped.** button beside ▶ Live lights
  while the pedal is down (from the MIDI input, on screen, or in playback). Hold it (or hold
  **P**), or click to latch it, to sustain the on-screen keys; it sends CC 64 to
  the output (WebSocket message `{ type: "pedal", down }`). Keys released under
  the pedal stay green, fading over `SUSTAIN_FADE_MS` (piano-roll.js) to a
  faint tint until it lifts (on playback as well as live), and the Live
  timeline draws pedal tails the same way the Import/Export roll does.
- **Import / Export tab** — export any recorded session to a Standard MIDI File
  (`GET /api/sessions/:id/export.mid`), import a `.mid` for preview/play without
  saving it on the server (`POST /api/midi/file/parse`; imports are kept in the
  browser), and view either as a **piano roll** that reuses the main keyboard +
  vertical timeline. A sticky transport bar holds **Import .mid** plus
  play/pause, stop, repeat, elapsed / total time, piano roll and score for the playing
  (or selected) item, so they stay in view while the lists scroll; rows carry
  play, download and delete (click twice to confirm). The piano roll shows the
  sustain pedal: notes it holds get a faint tail and their keys stay pale green
  until the pedal lifts, so the roll matches what's still sounding. The Live view, History
  preview and this tab share one `piano-roll.js` component (geometry, note
  pairing, chord-align, rendering).
- **Score view** — render a session or imported `.mid` as staff notation in a
  panel under the Import/Export bar, like the piano roll (`public/score.js`, VexFlow 4.2.5 vendored in `public/vendor/`). Note
  events are grouped into chords by onset, quantized, and laid out as 4/4
  grand-staff measures. Timing is approximate: quantized, with 4/4 and 120 BPM
  assumed and pitches spelled with sharps (no key signature); output is capped
  at 64 measures. Sustain pedal shows as brackets under the bass staff (with
  a notch at each re-pedal). The playing chord lights up and scrolls into view, and
  stays in step after a seek.
- **Pluggable MIDI transports** — device I/O now sits behind a transport
  interface selected by an address scheme. Linux defaults to the ALSA sequencer
  by name (`seq`, via `@julusian/midi`/RtMidi), which is PipeWire-shareable and
  immune to `/dev/snd` index churn, and auto-falls back to the raw device
  (`rawalsa`) when no sequencer port exists. Adds **RTP-MIDI** over UDP
  (`rtpm:` multicast, `rtp:` unicast; interops with qmidinet). Choose with
  `MIDIBOX_MIDI`; `GET /api/midi/transports` reports what's available.
- **Input device picker** — a dropdown beside the recording status switches the
  capture device (and folds in Refresh); playback defaults to a matching output.
- **Align chords (≣)** — a display-only toggle on the timeline that draws a
  chord's onsets at a shared time. Notes are chained while consecutive onsets
  are within ~12 ms (a chord arrives at a steady serial rate on a USB-DIN
  adapter, ~5 ms/note, so even a 7-note chord spanning ~30 ms groups, while
  deliberate arpeggios don't), capped at 60 ms and adjustable with a slider that
  appears beside the toggle. Recording and playback keep the
  true timestamps; `MIDIBOX_CAPTURE_DEBUG=1` logs arrival-vs-stored timing to
  confirm the spread is upstream (adapter), not software.
- **Tighter playback timing** — the scheduler now sends all MIDI due at a
  wake-up back-to-back before any WebSocket work, so a chord's notes go out
  together instead of on separate timer ticks with broadcast serialization
  wedged between them. Scheduling lateness is logged per playback (avg/max),
  with `MIDIBOX_PLAYBACK_DEBUG=1` for per-batch detail. `scripts/midi-timing.ts`
  (`bun run midi:timing`) measures capture-side chord spread.
- **History tab** — recorded activity by date, each day split into stretches of
  continuous playing with sparklines, pitch range and note counts. Preview a
  stretch as a piano roll, play it back, or save it as a session.
- **Fullscreen mode** (⛶) — hands the whole page to the keyboard and timeline.
  Works on iPad, where Safari won't fullscreen anything but a `<video>`.
- **iPad support** — Add to Home Screen runs it without browser chrome, plus
  safe-area padding, touch targets and gesture handling.
- **Connect Out** — the MIDI output is opened explicitly from the header rather
  than as a side effect of playback, so clicked keys and thru work before
  anything has been played. `GET/POST/DELETE /api/midi/output`.
- **Live update rate** — the timeline steps forward on a note length (1/1 to
  1/16, dotted and triplet) against a 40–220 BPM slider, or continuously at 60 Hz.
- **Timeline direction toggle** (⇅) — time runs downward or upward.
- **systemd unit** alongside the OpenRC script, with `CAP_NET_BIND_SERVICE` so
  port 80 works without root. `install-service.sh` now detects the init system,
  takes `--port`, and refuses to overwrite an existing install without `--force`.
- **Tests** — storage, API and browser suites (`bun test`, `bun run test:ui`)
  and a CI workflow.
- **Documentation** — INSTALL, USAGE, API and ARCHITECTURE.

### Changed

- The timeline is **vertical**: time runs down the screen, pitch across, aligned
  with the keyboard directly above it. The keyboard is sized in percentages, so
  a note's bar sits under its key at any window width.
- The event log moved into a draggable floating window, freeing the space the
  timeline now uses.
- **Live mode makes no HTTP requests.** Events arrive over the WebSocket, which
  they always did; the periodic re-read was redundant.
- `MIDIBOX_PORT` (and `PORT`) are honoured — previously the port was hardcoded
  despite the service files advertising the variable.
- `MIDIBOX_DB` relocates the database.

### Fixed

- MIDI output write failures were unhandled promise rejections, so a permission
  problem looked like silence. They are reported now, and connecting probes the
  device so failures surface with a usable message.
- Playback errors from the server reach the UI instead of being swallowed.
- A privileged-port bind failure explains itself instead of printing a stack.
- The timeline card could overflow its clipped parent on short screens, hiding
  the time labels and the controls beneath it.

### Removed

- Bank tagging (dropdown, history filter, per-session tag, `/api/bank`). It was
  added and removed within this branch; see the migration note above.
