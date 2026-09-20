// Storage and history aggregation. Runs against a throwaway database:
// bun test picks up MIDIBOX_DB from test/setup.ts.
import { expect, test, describe, beforeEach } from "bun:test";
import {
  recordEvent,
  getRange,
  getRecent,
  createSession,
  listSessions,
  updateSessionById,
  deleteSessionById,
  getDaySummaries,
  getActivitySegments,
  getSessionsInRange,
  db,
} from "../src/db";

const BASE = Date.UTC(2026, 0, 15, 12, 0, 0);

function note(at: number, pitch = 60, velocity = 90) {
  recordEvent({ timestamp: at, channel: 0, type: "noteon", note: pitch, velocity });
  recordEvent({ timestamp: at + 200, channel: 0, type: "noteoff", note: pitch, velocity: 0 });
}

beforeEach(() => {
  db.run("DELETE FROM midi_events");
  db.run("DELETE FROM sessions");
});

describe("write path", () => {
  // Guards the fix for chords recording arpeggiated: a synchronous fsync per
  // insert (rollback-journal mode) stalled the event loop 50-140 ms on an SD
  // card, inflating each event's timestamp. WAL + synchronous=NORMAL keeps
  // inserts off the fsync path.
  test("runs in WAL with synchronous=NORMAL", () => {
    const jm = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    const sync = db.query("PRAGMA synchronous").get() as { synchronous: number };
    expect(jm.journal_mode).toBe("wal");
    expect(sync.synchronous).toBe(1); // 1 = NORMAL
  });
});

describe("events", () => {
  test("round-trip a note", () => {
    note(BASE, 64, 100);
    const events = getRange(BASE - 1, BASE + 1000);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "noteon", note: 64, velocity: 100 });
    expect(events[1]).toMatchObject({ type: "noteoff", note: 64 });
  });

  test("range is inclusive and ordered", () => {
    note(BASE + 3000);
    note(BASE + 1000);
    note(BASE + 2000);
    const stamps = getRange(BASE, BASE + 3000).map((e) => e.timestamp);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(getRange(BASE + 1000, BASE + 1000)).toHaveLength(1); // the note-on exactly on the bound
  });

  test("recent uses a cutoff, not a range", () => {
    recordEvent({ timestamp: Date.now() - 10_000, channel: 0, type: "noteon", note: 60, velocity: 80 });
    recordEvent({ timestamp: Date.now() - 10 * 60_000, channel: 0, type: "noteon", note: 61, velocity: 80 });
    expect(getRecent(Date.now() - 60_000)).toHaveLength(1);
  });
});

describe("sessions", () => {
  test("create, list, update, delete", () => {
    const id = createSession({ start_time: BASE, end_time: BASE + 60_000, song_name: "Prelude", performer: "Lily" });
    expect(listSessions()).toHaveLength(1);

    expect(updateSessionById(id, { start_time: BASE, end_time: BASE + 30_000, song_name: "Prelude II" })).toBe(true);
    const updated = listSessions()[0]!;
    expect(updated.song_name).toBe("Prelude II");
    expect(updated.end_time).toBe(BASE + 30_000);

    expect(deleteSessionById(id)).toBe(true);
    expect(listSessions()).toHaveLength(0);
    expect(deleteSessionById(id)).toBe(false); // already gone
  });

  test("overlap query catches partial overlaps at both edges", () => {
    createSession({ start_time: BASE, end_time: BASE + 60_000, song_name: "middle" });
    expect(getSessionsInRange(BASE + 30_000, BASE + 90_000)).toHaveLength(1); // starts before
    expect(getSessionsInRange(BASE - 30_000, BASE + 10_000)).toHaveLength(1); // ends after
    expect(getSessionsInRange(BASE + 120_000, BASE + 180_000)).toHaveLength(0);
  });
});

describe("activity segments", () => {
  test("splits on silence longer than the gap", () => {
    for (let i = 0; i < 5; i++) note(BASE + i * 500);
    for (let i = 0; i < 5; i++) note(BASE + 120_000 + i * 500); // two minutes later

    expect(getActivitySegments(BASE - 1000, BASE + 200_000, 60_000)).toHaveLength(2);
    // With a wider gap the same events are one stretch
    expect(getActivitySegments(BASE - 1000, BASE + 200_000, 5 * 60_000)).toHaveLength(1);
  });

  test("summarises each stretch", () => {
    note(BASE, 48, 70);
    note(BASE + 1000, 72, 110);
    const [segment] = getActivitySegments(BASE - 1000, BASE + 10_000);

    expect(segment).toBeDefined();
    expect(segment!.note_count).toBe(2);
    expect(segment!.event_count).toBe(4); // note-offs count as events
    expect(segment!.min_note).toBe(48);
    expect(segment!.max_note).toBe(72);
    expect(segment!.avg_velocity).toBe(90);
    expect(segment!.density).toHaveLength(48);
    expect(segment!.density.reduce((a, b) => a + b, 0)).toBe(2);
  });

  test("ignores stretches below the note threshold", () => {
    note(BASE);
    expect(getActivitySegments(BASE - 1000, BASE + 10_000, 60_000, 2)).toHaveLength(0);
  });
});

describe("day summaries", () => {
  test("groups by the client's local midnight", () => {
    // 23:30 UTC on the 15th is still the 15th in UTC, but the 16th at UTC+2
    const late = Date.UTC(2026, 0, 15, 23, 30);
    note(late);

    expect(getDaySummaries(0)[0]!.date).toBe("2026-01-15");
    expect(getDaySummaries(-120)[0]!.date).toBe("2026-01-16"); // getTimezoneOffset() is -120 at UTC+2
  });

  test("counts notes, events and sessions per day", () => {
    note(BASE);
    note(BASE + 1000);
    recordEvent({ timestamp: BASE + 2000, channel: 0, type: "cc", control: 64, value: 127 });
    createSession({ start_time: BASE, end_time: BASE + 5000, song_name: "x" });

    const [day] = getDaySummaries(0);
    expect(day!.note_count).toBe(2);
    expect(day!.event_count).toBe(5); // 2 on + 2 off + 1 cc
    expect(day!.session_count).toBe(1);
    expect(day!.first_event).toBe(BASE);
  });

  test("newest first", () => {
    note(Date.UTC(2026, 0, 10, 12));
    note(Date.UTC(2026, 0, 12, 12));
    expect(getDaySummaries(0).map((d) => d.date)).toEqual(["2026-01-12", "2026-01-10"]);
  });
});
