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

### Added

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
