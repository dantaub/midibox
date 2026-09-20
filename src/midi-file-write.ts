// Standard MIDI File writer - the mirror of midi-file.ts, for exporting a
// recorded session. Recordings carry absolute millisecond timestamps and no
// tempo, so we pick a fixed tempo + PPQ and convert ms -> ticks. The result is
// a format-0 file (one track) that plays back at the original wall-clock timing.

import type { MidiEvent } from "./db";

const DEFAULT_PPQ = 480;
const DEFAULT_TEMPO_BPM = 120;

// Variable-length quantity (MIDI delta-time encoding).
function writeVarLen(value: number): number[] {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

// The MIDI status + data bytes for one recorded event, or null to skip it.
function eventBytes(e: MidiEvent): number[] | null {
  const ch = e.channel & 0x0f;
  switch (e.type) {
    case "noteon":
      return [0x90 | ch, e.note! & 0x7f, e.velocity! & 0x7f];
    case "noteoff":
      return [0x80 | ch, e.note! & 0x7f, (e.velocity ?? 0) & 0x7f];
    case "cc":
      return [0xb0 | ch, e.control! & 0x7f, e.value! & 0x7f];
    case "program":
      return [0xc0 | ch, e.value! & 0x7f];
    case "pressure":
      return [0xd0 | ch, e.value! & 0x7f];
    case "polytouch":
      return [0xa0 | ch, e.note! & 0x7f, e.value! & 0x7f];
    case "pitchbend":
      return [0xe0 | ch, e.value! & 0x7f, (e.value! >> 7) & 0x7f];
    default:
      return null; // raw / unknown
  }
}

function chunk(type: string, body: number[]): number[] {
  const len = body.length;
  return [
    ...type.split("").map((c) => c.charCodeAt(0)),
    (len >> 24) & 0xff,
    (len >> 16) & 0xff,
    (len >> 8) & 0xff,
    len & 0xff,
    ...body,
  ];
}

export interface WriteOptions {
  ppq?: number;
  tempoBpm?: number;
}

// Build a format-0 SMF from recorded events (absolute ms timestamps).
export function writeMidiFile(events: MidiEvent[], opts: WriteOptions = {}): Uint8Array {
  const ppq = opts.ppq ?? DEFAULT_PPQ;
  const tempoBpm = opts.tempoBpm ?? DEFAULT_TEMPO_BPM;
  const msPerBeat = 60000 / tempoBpm;
  const usPerBeat = Math.round(60000000 / tempoBpm);

  const t0 = events.length ? events[0]!.timestamp : 0;
  const toTicks = (ms: number) => ((ms - t0) * ppq) / msPerBeat;

  // Stable sort by time so a chord's notes keep their recorded order.
  const timed = events
    .map((e, i) => ({ e, i, ticks: toTicks(e.timestamp) }))
    .filter((x) => eventBytes(x.e) !== null)
    .sort((a, b) => a.ticks - b.ticks || a.i - b.i);

  const track: number[] = [];

  // Tempo meta at delta 0 (FF 51 03 tttttt), so the file's timing is defined.
  track.push(
    0x00,
    0xff,
    0x51,
    0x03,
    (usPerBeat >> 16) & 0xff,
    (usPerBeat >> 8) & 0xff,
    usPerBeat & 0xff
  );

  let prevTicks = 0;
  for (const { e, ticks } of timed) {
    const delta = ticks - prevTicks;
    prevTicks = ticks;
    track.push(...writeVarLen(delta), ...eventBytes(e)!);
  }

  // End of track
  track.push(0x00, 0xff, 0x2f, 0x00);

  const header = chunk("MThd", [
    0x00, 0x00, // format 0
    0x00, 0x01, // one track
    (ppq >> 8) & 0xff,
    ppq & 0xff,
  ]);

  return new Uint8Array([...header, ...chunk("MTrk", track)]);
}
