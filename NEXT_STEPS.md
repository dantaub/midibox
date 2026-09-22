# Next steps

Candidate directions, roughly in priority order. Each notes why it matters, the
rough effort, and a concrete first move. See [ARCHITECTURE.md](ARCHITECTURE.md)
for how the pieces fit and [API.md](API.md) for the current surface.

## 1. Durability: back the recordings up to the cloud

**Why:** the database is the irreplaceable asset and it lives on a Raspberry Pi
SD card, which fails. There is no backup and the file grows forever
(ARCHITECTURE "Gotchas").

**Litestream (recommended).** Continuously replicates the SQLite WAL to object
storage (S3 / Backblaze B2 / GCS / Azure). Runs as a **sidecar — no app code
changes** — and gives point-in-time restore and restore-on-boot. The WAL mode
the DB now uses (`src/db.ts`) is exactly what Litestream ships.
- *Effort:* small (config + service + docs).
- *First move:* add a `litestream.yml` example and a `scripts/` restore helper;
  document setup in INSTALL (systemd `Requires=`/`After=` ordering, or the
  `litestream replicate` wrapper that execs the app). Point `MIDIBOX_DB` at the
  replicated file.
- *Watch out:* back up via `sqlite3 .backup` or Litestream, never a bare `cp` of
  a live WAL database.

**Retention / pruning (pairs with backup).** A policy to age out or archive old
`midi_events` (e.g. keep everything inside a saved session, thin the rest, or
ship cold data to the cloud). Keeps the SD card and backups bounded.
- *Effort:* small–medium. *First move:* a `DELETE FROM midi_events WHERE ...`
  maintenance query behind an endpoint or a scheduled task, plus a config knob.

## 2. Import/Export tab — ✅ shipped

Done: the **Import / Export** tab, a shared `public/piano-roll.js` component
(Live + History preview + popup), session **export** to `.mid`
(`GET /api/sessions/:id/export.mid`, `src/midi-file-write.ts`), `.mid` **import**
for preview/play (`POST /api/midi/file/parse`), and the **piano-roll popup**.

Also done — the **score view** (`public/score.js`, VexFlow 4.2.5 UMD vendored
into `public/vendor/`). `openScoreView(events, {title})` renders a session or
imported file as notation in a modal: `pairNoteBars` → onset-grouped chords →
quantized durations → 4/4 grand-staff measures (treble/bass split at middle C,
sharp spellings, no key signature). Timing is quantized and 120 BPM / 4/4 are
assumed (stated in the modal footer); voices render non-strict so partial
measures don't need rest/tie padding, and output is capped at
`SCORE_MAX_MEASURES`. It's heuristic by nature.

**Possible follow-ups:** tempo/key detection to replace the fixed assumptions,
split-across-barline durations with ties, and honoring an import's real
rhythm/PPQ (the parse endpoint has `durationMs` but the score path treats every
source as raw timestamped events for a single code path).

## 3. Analysis on the recordings

**Why:** the data is captured and already half-summarised (history sparklines,
pitch range, density in `getActivitySegments`). Practice analytics and musical
analysis are natural extensions.

- Ideas: per-session stats (time played, keys/scales touched, tempo estimate),
  chord/key detection, simple auto-transcription.
- *Effort:* medium–large depending on ambition. *First move:* extend the history
  segment summary with a key/tempo estimate; surface it in the History view.

## 4. Secure remote access

**Why:** the server is LAN-only with **no authentication and no TLS**
(API.md header). "Reach it from anywhere" should not mean rolling our own crypto.

- **Tailscale** or **Cloudflare Tunnel** in front of the Pi — encrypted,
  reversible, no code. Recommended over a public port.
- If a real auth layer is ever wanted: a reverse proxy (nginx/Caddy) with basic
  auth or OAuth, which INSTALL already gestures at for privileged ports.
- *Effort:* small (tunnel) to medium (app-level auth). *First move:* document
  the Tailscale path in INSTALL; only add app auth if multi-user is a goal.

## 5. Capture-path hardening (follow-ups from the timing hunt)

**Why:** WAL fixed the dominant fsync stall, but a couple of robustness gaps
remain (see the chord-timing investigation and ARCHITECTURE "Gotchas").

- **Stamp the timestamp at arrival**, not after processing. RtMidi's driver-layer
  `deltaTime` is already threaded to `handleIncoming` (used by
  `MIDIBOX_CAPTURE_DEBUG`); use an arrival clock for the stored timestamp so no
  future event-loop stall (broadcast, GC) can inflate chord timing.
- **Async / batched inserts** if capture ever needs to scale beyond one player.
- *Effort:* small each.

## 6. Finish RTP-MIDI

**Why:** the network transport (`src/transports/rtpmidi.ts`) is v1 — plain
multicast/unicast (qmidinet-compatible), no AppleMIDI session handshake,
discovery, or journal.

- *First move:* AppleMIDI invitation + control/data port pairing for unicast
  peers; mDNS discovery is a further step (avoid the native `mdns` dep — the
  reason we hand-rolled RTP in the first place).
- *Effort:* medium–large.

## Small / housekeeping

- Fix the one pre-existing failing test: connecting a missing **CoreMIDI** output
  falls back to the first device instead of failing (macOS-only; the `seq` path
  already fails correctly after the `findPort` fix).
- Consider exposing the chord-align gap and the RTP endpoints in the UI rather
  than only via config/localStorage, if either sees real use.

---

Suggested order: **1 (Litestream) → 2 (MIDI export) → 4 (Tailscale)**. Backup
protects what can't be recreated for the least effort; export unlocks the
recordings; secure access is a no-code tunnel when you need it.




OTHER THINGS:

Loading a midi file in "learning mode" where it shows the key(s) you're supposed to press next, and it proceeds after you successfully do that. Import an image and have it try to show you how to play that picture.

