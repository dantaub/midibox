# MidiBox API

Everything the web UI does goes through these. No authentication — see the note
in [INSTALL.md](INSTALL.md#troubleshooting) before exposing the port.

Base URL: `http://<host>:4000`. All bodies and responses are JSON unless stated.
Timestamps are epoch milliseconds.

## Events

### `GET /api/events/recent?minutes=5`

Events from the last N minutes (default 5), oldest first.

### `GET /api/events/range?start=<ms>&end=<ms>`

Events in a time range, oldest first.

```json
[
  { "id": 1, "timestamp": 1769394000000, "channel": 0, "type": "noteon",
    "note": 60, "velocity": 92, "control": null, "value": null, "data": null }
]
```

`type` is one of `noteon`, `noteoff`, `cc`, `pitchbend`, `program`, `pressure`,
`polytouch`, `raw`. Which fields are populated depends on the type.

## History

### `GET /api/history/days?tz=<offset>&limit=500`

Per-day totals, newest first. `tz` is the client's
`new Date().getTimezoneOffset()` so days break at the viewer's local midnight.

```json
[
  { "date": "2026-01-25", "event_count": 41804, "note_count": 19224,
    "first_event": 1769353664876, "last_event": 1769396858700, "session_count": 13 }
]
```

### `GET /api/history/segments?start=<ms>&end=<ms>&gap=60000`

Splits a range into stretches of continuous playing, divided wherever the
silence exceeds `gap` (default 60000 ms). Returns the sessions overlapping the
range too.

```json
{
  "start": 1769353664000,
  "end": 1769396859000,
  "segments": [
    { "start": 1769353664876, "end": 1769354076212, "event_count": 1807,
      "note_count": 836, "min_note": 24, "max_note": 86, "avg_velocity": 69,
      "density": [46, 41, 24, "…48 buckets"] }
  ],
  "sessions": []
}
```

`density` is note-on counts bucketed evenly across the segment — enough for a
sparkline without fetching the events.

## Sessions

| Method | Path | Body | Result |
| ------ | ---- | ---- | ------ |
| `GET` | `/api/sessions` | — | All sessions, newest first |
| `POST` | `/api/sessions` | `{start_time, end_time, performer?, song_name?}` | `201 {id}` |
| `PUT` | `/api/sessions/:id` | same | `{success: true}` or `404` |
| `DELETE` | `/api/sessions/:id` | — | `{success: true}` or `404` |

```bash
curl -X POST localhost:4000/api/sessions -H 'content-type: application/json' \
  -d '{"start_time":1769394000000,"end_time":1769394600000,"song_name":"Prelude","performer":"Lily"}'
```

## MIDI devices

| Method | Path | Result |
| ------ | ---- | ------ |
| `GET` | `/api/midi/inputs` | Device names (Linux: `/dev/snd/...` paths) |
| `GET` | `/api/midi/outputs` | Same list on Linux; CoreMIDI names on macOS |
| `GET` | `/api/midi/input` | `{input}` — device now recording, `null` when stopped |
| `POST` | `/api/midi/input` | `{input}` — switch recording device (stop + start) |
| `POST` | `/api/midi/start` | `{input?}` — (re)start capture |
| `POST` | `/api/midi/stop` | Stop capture |

### Output connection

| Method | Path | Body | Result |
| ------ | ---- | ---- | ------ |
| `GET` | `/api/midi/output` | — | `{output}` — `null` when disconnected |
| `POST` | `/api/midi/output` | `{output}` | `{status:"connected", output}` |
| `DELETE` | `/api/midi/output` | — | `{status:"disconnected"}` |

Connecting probes the device with an Active Sensing byte, so a permission or
busy-device problem fails here with a message rather than silently swallowing
every later note. One output is open at a time.

### MIDI thru

| Method | Path | Body | Result |
| ------ | ---- | ---- | ------ |
| `GET` | `/api/midi/thru` | — | `{enabled, output}` |
| `POST` | `/api/midi/thru` | `{output?}` | `{status:"enabled", output}` |
| `DELETE` | `/api/midi/thru` | — | `{status:"disabled"}` |

## Playback

### `POST /api/playback/start`

```json
{ "start": 1769394000000, "end": 1769394600000, "output": "/dev/snd/midiC0D0" }
```

Replays the recorded events in that range at their original timing, to the MIDI
output and to every WebSocket client. `output` is optional if already connected.
Returns `{status:"playing", eventCount, duration}`. Errors (no device, no
permission) come back as `500 {error}`.

### `POST /api/playback/stop`

Stops immediately. `{status:"stopped"}`.

### `POST /api/playback/file`

`multipart/form-data` with `file` (a `.mid`, format 0 or 1) and optional
`output`. Parses and plays it, tempo changes included; nothing is recorded.

```bash
curl -X POST localhost:4000/api/playback/file \
  -F file=@prelude.mid -F output=/dev/snd/midiC0D0
```

Returns `{status, fileName, eventCount, duration, format, tracks}`.

## WebSocket

Connect to `ws://<host>:4000/ws`. Messages are JSON objects tagged by `type`.

### Server to client

| Type | Payload | When |
| ---- | ------- | ---- |
| `midi` | `{event}` | A MIDI event was captured — this is the live feed |
| `playback` | `{status: "started"\|"ended", totalEvents, duration}` | Playback boundaries |
| `playback-event` | `{event, progress, eventIndex, totalEvents}` | Each event as it plays |
| `output` | `{output}` | The output was connected or disconnected |
| `input` | `{input}` | The recording input device changed |
| `pong` | — | Reply to `ping` |

### Client to server

| Type | Payload | Effect |
| ---- | ------- | ------ |
| `ping` | — | Server replies `pong` |
| `playNote` | `{note, velocity?, on}` | Send a note on/off to the output |

Because every captured event is pushed over this socket, a live view never has
to poll the HTTP API.
