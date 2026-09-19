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

// Key/value store for server-side settings (e.g. the active recording bank)
db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

// ---------------------------------------------------------------
// Migrations - additive only, so databases written by older
// versions (and older code reading this database) keep working.
// ---------------------------------------------------------------
function hasColumn(table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

// Bank tagging: nullable, so pre-existing rows simply read as untagged
if (!hasColumn("midi_events", "bank")) {
  db.run(`ALTER TABLE midi_events ADD COLUMN bank TEXT`);
}
if (!hasColumn("sessions", "bank")) {
  db.run(`ALTER TABLE sessions ADD COLUMN bank TEXT`);
}

db.run(`
  CREATE INDEX IF NOT EXISTS idx_midi_events_bank ON midi_events(bank)
`);

// Prepared statements for performance
const insertEvent = db.prepare(`
  INSERT INTO midi_events (timestamp, channel, type, note, velocity, control, value, data, bank)
  VALUES ($timestamp, $channel, $type, $note, $velocity, $control, $value, $data, $bank)
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
  INSERT INTO sessions (start_time, end_time, performer, song_name, bank)
  VALUES ($start_time, $end_time, $performer, $song_name, $bank)
`);

// $bank: null leaves the existing tag alone (old clients don't send one),
// '' clears it, a letter replaces it.
const updateSession = db.prepare(`
  UPDATE sessions
  SET start_time = $start_time, end_time = $end_time, performer = $performer, song_name = $song_name,
      bank = CASE WHEN $bank IS NULL THEN bank WHEN $bank = '' THEN NULL ELSE $bank END
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
  /** Lettered bank (A-L) the event was tagged with, or null/undefined for untagged */
  bank?: string | null;
}

export interface Session {
  id?: number;
  start_time: number;
  end_time: number;
  performer?: string;
  song_name?: string;
  created_at?: number;
  bank?: string | null;
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
    $bank: normalizeBank(event.bank),
  });
}

// ---------------------------------------------------------------
// Banks
// ---------------------------------------------------------------

/** Selectable banks on the main page: A through L */
export const BANKS = "ABCDEFGHIJKL".split("");

/** Filter value meaning "events with no bank tag" */
export const UNTAGGED = "none";

/** Returns a valid bank letter, or null for "all"/untagged/invalid input */
export function normalizeBank(bank: string | null | undefined): string | null {
  if (!bank) return null;
  const upper = String(bank).trim().toUpperCase();
  return BANKS.includes(upper) ? upper : null;
}

const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = $key`);
const setSettingStmt = db.prepare(`
  INSERT INTO settings (key, value) VALUES ($key, $value)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

export function getSetting(key: string): string | null {
  const row = getSettingStmt.get({ $key: key }) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null): void {
  setSettingStmt.run({ $key: key, $value: value });
}

let currentBank: string | null = normalizeBank(getSetting("current_bank"));

/** Bank that incoming MIDI is currently tagged with (null = "all"/untagged) */
export function getCurrentBank(): string | null {
  return currentBank;
}

export function setCurrentBank(bank: string | null | undefined): string | null {
  currentBank = normalizeBank(bank);
  setSetting("current_bank", currentBank);
  return currentBank;
}

/**
 * Builds a SQL fragment for a bank filter.
 * - undefined/null/"all" -> no filter
 * - "none" -> untagged rows only (includes rows written before banks existed)
 * - "A".."L" -> that bank only
 */
function bankFilter(bank: string | null | undefined, column = "bank"): { sql: string; value: string | null } {
  if (!bank || bank === "all") return { sql: "", value: null };
  if (bank === UNTAGGED) return { sql: `${column} IS NULL`, value: null };
  const normalized = normalizeBank(bank);
  if (!normalized) return { sql: "", value: null };
  return { sql: `${column} = $bank`, value: normalized };
}

export function getRecent(sinceMs: number, bank?: string | null): MidiEvent[] {
  const filter = bankFilter(bank);
  if (!filter.sql) return getRecentEvents.all({ $since: sinceMs }) as MidiEvent[];
  return db
    .query(`SELECT * FROM midi_events WHERE timestamp > $since AND ${filter.sql} ORDER BY timestamp ASC`)
    .all(filter.value === null ? { $since: sinceMs } : { $since: sinceMs, $bank: filter.value }) as MidiEvent[];
}

export function getRange(startMs: number, endMs: number, bank?: string | null): MidiEvent[] {
  const filter = bankFilter(bank);
  if (!filter.sql) return getEventsInRange.all({ $start: startMs, $end: endMs }) as MidiEvent[];
  const params: Record<string, unknown> = { $start: startMs, $end: endMs };
  if (filter.value !== null) params.$bank = filter.value;
  return db
    .query(`SELECT * FROM midi_events WHERE timestamp BETWEEN $start AND $end AND ${filter.sql} ORDER BY timestamp ASC`)
    .all(params) as MidiEvent[];
}

export function createSession(session: Session): number {
  // Old clients don't send a bank - derive the dominant one from the range
  const bank = session.bank === undefined ? dominantBankInRange(session.start_time, session.end_time) : normalizeBank(session.bank);
  const result = insertSession.run({
    $start_time: session.start_time,
    $end_time: session.end_time,
    $performer: session.performer ?? null,
    $song_name: session.song_name ?? null,
    $bank: bank,
  });
  return Number(result.lastInsertRowid);
}

/** Most frequently used bank among the events in a time range (null if mostly untagged) */
export function dominantBankInRange(startMs: number, endMs: number): string | null {
  const row = db
    .query(
      `SELECT bank, COUNT(*) AS n FROM midi_events
       WHERE timestamp BETWEEN $start AND $end AND bank IS NOT NULL
       GROUP BY bank ORDER BY n DESC LIMIT 1`
    )
    .get({ $start: startMs, $end: endMs }) as { bank: string; n: number } | null;
  return row?.bank ?? null;
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
    // undefined -> keep whatever tag the session already has
    $bank: session.bank === undefined ? null : session.bank === null ? "" : normalizeBank(session.bank) ?? "",
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
  banks: string[];
  session_count: number;
}

/**
 * Per-day activity totals, newest first.
 * @param tzOffsetMin Date#getTimezoneOffset() of the client, so days line up with its local midnight
 */
export function getDaySummaries(tzOffsetMin: number, bank?: string | null, limit = 500): DaySummary[] {
  const offsetMs = Math.round(tzOffsetMin) * 60 * 1000;
  const filter = bankFilter(bank);
  const where = filter.sql ? `WHERE ${filter.sql}` : "";
  const params: Record<string, unknown> = { $off: offsetMs, $limit: limit };
  if (filter.value !== null) params.$bank = filter.value;

  const rows = db
    .query(
      `SELECT strftime('%Y-%m-%d', (timestamp - $off) / 1000, 'unixepoch') AS date,
              COUNT(*) AS event_count,
              SUM(CASE WHEN type = 'noteon' AND velocity > 0 THEN 1 ELSE 0 END) AS note_count,
              MIN(timestamp) AS first_event,
              MAX(timestamp) AS last_event,
              GROUP_CONCAT(DISTINCT bank) AS banks
       FROM midi_events
       ${where}
       GROUP BY date
       ORDER BY date DESC
       LIMIT $limit`
    )
    .all(params) as (Omit<DaySummary, "banks" | "session_count"> & { banks: string | null })[];

  // Session counts per day (sessions are tagged too, so the same filter applies)
  const sessionFilter = bankFilter(bank);
  const sessionParams: Record<string, unknown> = { $off: offsetMs };
  if (sessionFilter.value !== null) sessionParams.$bank = sessionFilter.value;
  const sessionRows = db
    .query(
      `SELECT strftime('%Y-%m-%d', (start_time - $off) / 1000, 'unixepoch') AS date, COUNT(*) AS n
       FROM sessions
       ${sessionFilter.sql ? `WHERE ${sessionFilter.sql}` : ""}
       GROUP BY date`
    )
    .all(sessionParams) as { date: string; n: number }[];
  const sessionCounts = new Map(sessionRows.map((r) => [r.date, r.n]));

  return rows.map((r) => ({
    ...r,
    banks: r.banks ? r.banks.split(",").filter(Boolean).sort() : [],
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
  banks: Record<string, number>;
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
  bank?: string | null,
  gapMs = 60 * 1000,
  minNotes = 1
): ActivitySegment[] {
  const events = getRange(startMs, endMs, bank);
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
    const banks: Record<string, number> = {};
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
    for (const e of current) {
      const key = e.bank ?? "-";
      banks[key] = (banks[key] ?? 0) + 1;
    }

    segments.push({
      start: segStart,
      end: segEnd,
      event_count: current.length,
      note_count: noteOns.length,
      min_note: minNote,
      max_note: maxNote,
      avg_velocity: noteOns.length ? Math.round(velSum / noteOns.length) : 0,
      banks,
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

export function getSessionsInRange(startMs: number, endMs: number, bank?: string | null): Session[] {
  const filter = bankFilter(bank);
  const params: Record<string, unknown> = { $start: startMs, $end: endMs };
  if (filter.value !== null) params.$bank = filter.value;
  return db
    .query(
      `SELECT * FROM sessions
       WHERE end_time >= $start AND start_time <= $end
       ${filter.sql ? `AND ${filter.sql}` : ""}
       ORDER BY start_time ASC`
    )
    .all(params) as Session[];
}

export { db };
