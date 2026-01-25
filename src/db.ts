import { Database } from "bun:sqlite";

const db = new Database("midibox.db", { create: true });

// Initialize schema
db.run(`
  CREATE TABLE IF NOT EXISTS midi_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    channel INTEGER NOT NULL,
    type TEXT NOT NULL,
    note INTEGER,
    velocity INTEGER,
    control INTEGER,
    value INTEGER,
    data BLOB
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    performer TEXT,
    song_name TEXT,
    created_at INTEGER DEFAULT (unixepoch() * 1000)
  )
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_midi_events_timestamp ON midi_events(timestamp)
`);

// Prepared statements for performance
const insertEvent = db.prepare(`
  INSERT INTO midi_events (timestamp, channel, type, note, velocity, control, value, data)
  VALUES ($timestamp, $channel, $type, $note, $velocity, $control, $value, $data)
`);

const getRecentEvents = db.prepare(`
  SELECT * FROM midi_events
  WHERE timestamp > $since
  ORDER BY timestamp ASC
`);

const getEventsInRange = db.prepare(`
  SELECT * FROM midi_events
  WHERE timestamp BETWEEN $start AND $end
  ORDER BY timestamp ASC
`);

const insertSession = db.prepare(`
  INSERT INTO sessions (start_time, end_time, performer, song_name)
  VALUES ($start_time, $end_time, $performer, $song_name)
`);

const getSessions = db.prepare(`
  SELECT * FROM sessions ORDER BY start_time DESC
`);

export interface MidiEvent {
  id?: number;
  timestamp: number;
  channel: number;
  type: string;
  note?: number;
  velocity?: number;
  control?: number;
  value?: number;
  data?: Uint8Array;
}

export interface Session {
  id?: number;
  start_time: number;
  end_time: number;
  performer?: string;
  song_name?: string;
  created_at?: number;
}

export function recordEvent(event: MidiEvent): void {
  insertEvent.run({
    $timestamp: event.timestamp,
    $channel: event.channel,
    $type: event.type,
    $note: event.note ?? null,
    $velocity: event.velocity ?? null,
    $control: event.control ?? null,
    $value: event.value ?? null,
    $data: event.data ?? null,
  });
}

export function getRecent(sinceMs: number): MidiEvent[] {
  return getRecentEvents.all({ $since: sinceMs }) as MidiEvent[];
}

export function getRange(startMs: number, endMs: number): MidiEvent[] {
  return getEventsInRange.all({ $start: startMs, $end: endMs }) as MidiEvent[];
}

export function createSession(session: Session): number {
  const result = insertSession.run({
    $start_time: session.start_time,
    $end_time: session.end_time,
    $performer: session.performer ?? null,
    $song_name: session.song_name ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function listSessions(): Session[] {
  return getSessions.all() as Session[];
}

export { db };
