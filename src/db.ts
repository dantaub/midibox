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

const updateSession = db.prepare(`
  UPDATE sessions
  SET start_time = $start_time, end_time = $end_time, performer = $performer, song_name = $song_name
  WHERE id = $id
`);

const deleteSession = db.prepare(`
  DELETE FROM sessions WHERE id = $id
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

export function updateSessionById(id: number, session: Session): boolean {
  const result = updateSession.run({
    $id: id,
    $start_time: session.start_time,
    $end_time: session.end_time,
    $performer: session.performer ?? null,
    $song_name: session.song_name ?? null,
  });
  return result.changes > 0;
}

export function deleteSessionById(id: number): boolean {
  const result = deleteSession.run({ $id: id });
  return result.changes > 0;
}

// ---------------------------------------------------------------
// History views
// ---------------------------------------------------------------

export interface DaySummary {
  date: string; // YYYY-MM-DD in the requesting client's timezone
  event_count: number;
  note_count: number;
  first_event: number;
  last_event: number;
  session_count: number;
}

/**
 * Per-day activity totals, newest first.
 * @param tzOffsetMin Date#getTimezoneOffset() of the client, so days line up with its local midnight
 */
export function getDaySummaries(tzOffsetMin: number, limit = 500): DaySummary[] {
  const offsetMs = Math.round(tzOffsetMin) * 60 * 1000;

  const rows = db
    .query(
      `SELECT strftime('%Y-%m-%d', (timestamp - $off) / 1000, 'unixepoch') AS date,
              COUNT(*) AS event_count,
              SUM(CASE WHEN type = 'noteon' AND velocity > 0 THEN 1 ELSE 0 END) AS note_count,
              MIN(timestamp) AS first_event,
              MAX(timestamp) AS last_event
       FROM midi_events
       GROUP BY date
       ORDER BY date DESC
       LIMIT $limit`
    )
    .all({ $off: offsetMs, $limit: limit }) as Omit<DaySummary, "session_count">[];

  // Session counts per day
  const sessionRows = db
    .query(
      `SELECT strftime('%Y-%m-%d', (start_time - $off) / 1000, 'unixepoch') AS date, COUNT(*) AS n
       FROM sessions
       GROUP BY date`
    )
    .all({ $off: offsetMs }) as { date: string; n: number }[];
  const sessionCounts = new Map(sessionRows.map((r) => [r.date, r.n]));

  return rows.map((r) => ({
    ...r,
    session_count: sessionCounts.get(r.date) ?? 0,
  }));
}

export interface ActivitySegment {
  start: number;
  end: number;
  event_count: number;
  note_count: number;
  min_note: number | null;
  max_note: number | null;
  avg_velocity: number;
  /** note-on counts bucketed across the segment, for a sparkline */
  density: number[];
}

const DENSITY_BUCKETS = 48;

/**
 * Splits the events in a range into contiguous activity segments, separated by
 * silences longer than `gapMs`. Short blips (< minNotes) are dropped as noise.
 */
export function getActivitySegments(
  startMs: number,
  endMs: number,
  gapMs = 60 * 1000,
  minNotes = 1
): ActivitySegment[] {
  const events = getRange(startMs, endMs);
  const segments: ActivitySegment[] = [];

  let current: (MidiEvent & { _noteOn?: boolean })[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const noteOns = current.filter((e) => e.type === "noteon" && (e.velocity ?? 0) > 0);
    if (noteOns.length < minNotes) {
      current = [];
      return;
    }
    const segStart = current[0]!.timestamp;
    const segEnd = current[current.length - 1]!.timestamp;
    let velSum = 0;
    let minNote: number | null = null;
    let maxNote: number | null = null;
    const density = new Array(DENSITY_BUCKETS).fill(0);
    const span = Math.max(1, segEnd - segStart);

    for (const e of noteOns) {
      velSum += e.velocity ?? 0;
      if (e.note != null) {
        minNote = minNote === null ? e.note : Math.min(minNote, e.note);
        maxNote = maxNote === null ? e.note : Math.max(maxNote, e.note);
      }
      const bucket = Math.min(DENSITY_BUCKETS - 1, Math.floor(((e.timestamp - segStart) / span) * DENSITY_BUCKETS));
      density[bucket]++;
    }
    segments.push({
      start: segStart,
      end: segEnd,
      event_count: current.length,
      note_count: noteOns.length,
      min_note: minNote,
      max_note: maxNote,
      avg_velocity: noteOns.length ? Math.round(velSum / noteOns.length) : 0,
      density,
    });
    current = [];
  };

  for (const event of events) {
    if (current.length > 0 && event.timestamp - current[current.length - 1]!.timestamp > gapMs) {
      flush();
    }
    current.push(event);
  }
  flush();

  return segments;
}

export function getSessionsInRange(startMs: number, endMs: number): Session[] {
  return db
    .query(
      `SELECT * FROM sessions
       WHERE end_time >= $start AND start_time <= $end
       ORDER BY start_time ASC`
    )
    .all({ $start: startMs, $end: endMs }) as Session[];
}

export { db };
