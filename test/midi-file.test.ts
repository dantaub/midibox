// Round-trip the SMF writer through the parser: what we export must read back
// with the same notes and timing.
import { expect, test, describe } from "bun:test";
import { writeMidiFile } from "../src/midi-file-write";
import { parseMidiFile, getPlayableEvents } from "../src/midi-file";
import type { MidiEvent } from "../src/db";

const ev = (timestamp: number, type: MidiEvent["type"], note: number, velocity: number): MidiEvent => ({
  timestamp,
  channel: 0,
  type,
  note,
  velocity,
});

describe("SMF export round-trip", () => {
  test("a chord's notes and timing survive write -> parse", () => {
    const events: MidiEvent[] = [
      ev(1000, "noteon", 60, 90),
      ev(1000, "noteon", 64, 80),
      ev(1500, "noteoff", 60, 0),
      ev(1500, "noteoff", 64, 0),
    ];

    const bytes = writeMidiFile(events);
    const parsed = getPlayableEvents(parseMidiFile(bytes.buffer as ArrayBuffer));

    const ons = parsed.filter((e) => e.type === "noteon" && (e.velocity ?? 0) > 0);
    const offs = parsed.filter((e) => e.type === "noteoff" || (e.type === "noteon" && e.velocity === 0));

    expect(ons.map((e) => e.note).sort((a, b) => a! - b!)).toEqual([60, 64]);
    // Timing is relative to the first event: both onsets at 0 ms, releases at 500 ms.
    expect(Math.round(ons[0]!.timeMs)).toBe(0);
    expect(Math.round(offs[0]!.timeMs)).toBe(500);
  });

  test("a valid header is produced for an empty session", () => {
    const bytes = writeMidiFile([]);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)).toBe("MThd");
  });
});
