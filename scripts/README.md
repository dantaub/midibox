# Debug & diagnostic scripts

Small tools for measuring MIDI timing and driving a remote host (e.g. a
Raspberry Pi) during debugging. Service files (`*.service`, `install-service.sh`,
etc.) are documented in [INSTALL.md](../INSTALL.md).

## Timing

### `midi-timing.ts` — capture-side chord latency
```
bun run midi:timing [port-substring] [chord-window-ms]
```
Opens a MIDI input and reports, per message, RtMidi's `deltaTime` (protocol
floor), a high-res receive-clock delta (software-added latency) and the
`Date.now()` delta (recording granularity). Play chords; note-ons within the
window are grouped and their first→last spread is averaged. See the file header
for how to read the three columns.

### `timer-jitter.ts` — is it the timers or the work?
```
bun run scripts/timer-jitter.ts [intervalMs] [samples]
```
Pure `setTimeout` jitter. If this is sub-ms but real playback lateness is high,
the delay is **work on the event loop**, not the timers. (On a Pi 4 this reads
~0.1 ms; the playback path measured ~0.4 ms once a stray capture→SQLite write
was removed.)

Playback lateness itself is logged by the server: set
`MIDIBOX_PLAYBACK_DEBUG=1` for a per-batch line plus an avg/max summary.

## Database

### `db-inspect.ts` — read-only DB peek
```
bun run scripts/db-inspect.ts stats
bun run scripts/db-inspect.ts range <startMs> <endMs>
MIDIBOX_DB=/path/midibox.db bun run scripts/db-inspect.ts stats
```
Useful when a host has no `sqlite3` CLI. Never writes. Deletion is deliberately
manual — back up first (`cp midibox.db midibox.db.bak`), then delete with
`bun:sqlite` in a one-off.

## Remote control

### `remote.sh` — run a command on the MidiBox host
```
MIDIBOX_HOST=dorian@doorian.local ./scripts/remote.sh 'bun run midi:timing'
MIDIBOX_HOST=dorian@doorian.local ./scripts/remote.sh <<'SH'
  curl -s localhost:4200/api/midi/transports
SH
```
Feeds the command to a remote login shell over stdin with `~/.bun/bin` on PATH
and the working directory at the repo (`MIDIBOX_REMOTE_DIR`, default
`src/midibox`). Encodes the lessons from Pi debugging: bun isn't on the
non-interactive PATH, and nested quoting through `ssh '...'` is a trap — pipe a
heredoc instead.

### Measuring playback timing on a remote host
Start a throwaway server on a spare port aimed at the real DB, stop capture (so
nothing loops back), auto-pick the most recent activity segment, play it, and
read the lateness log. Copy-paste as-is — it derives the range itself:
```
MIDIBOX_HOST=dorian@doorian.local ./scripts/remote.sh <<'SH'
MIDIBOX_PLAYBACK_DEBUG=1 MIDIBOX_PORT=4200 nohup bun run start >/tmp/mbx.log 2>&1 &
echo $! >/tmp/mbx.pid; sleep 3
curl -s -X POST localhost:4200/api/midi/stop >/dev/null
bun -e '
const base="http://localhost:4200";
const days=await (await fetch(base+"/api/history/days?tz=0&limit=1")).json();
const d=days[0];
const seg=await (await fetch(base+"/api/history/segments?start="+d.first_event+"&end="+d.last_event+"&gap=5000")).json();
const s=seg.segments.find(x=>x.event_count>=8)||seg.segments[0];
console.log("range",s.start,s.end,"events",s.event_count);
await fetch(base+"/api/playback/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({start:s.start,end:s.end})});
await new Promise(r=>setTimeout(r,(s.end-s.start)+2000));
'
grep playback /tmp/mbx.log | tail -4
kill "$(cat /tmp/mbx.pid)"
SH
```
This measures the scheduler only (no output connected, so no sound). To also
exercise real MIDI out, `POST /api/midi/output {output:"<name>"}` first — but
pick a port nothing is capturing (see the gotcha below).

**Gotcha:** don't connect the output to a port that the capture is listening on
(e.g. `Midi Through` while also capturing it) — it loops played notes back into
capture, and each looped note is a synchronous DB write that both pollutes the
recording and skews the timing. Stop capture (`POST /api/midi/stop`) or send to
a port nothing is capturing.
