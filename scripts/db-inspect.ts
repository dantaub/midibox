// Read-only peek at the recording database - handy over ./scripts/remote.sh when
// a host has no sqlite3 CLI (the Pi didn't). Never writes.
//
//   bun run scripts/db-inspect.ts stats
//   bun run scripts/db-inspect.ts range <startMs> <endMs>
//   MIDIBOX_DB=/path/midibox.db bun run scripts/db-inspect.ts stats
//
// Deletion is intentionally not scripted - it's destructive on live recordings.
// Do it deliberately with a backup (see scripts/README.md).

import { Database } from "bun:sqlite";

const path = process.env.MIDIBOX_DB ?? "midibox.db";
const db = new Database(path, { readonly: true });
const cmd = process.argv[2] ?? "stats";

if (cmd === "stats") {
  const tot = db
    .query("select count(*) c, min(timestamp) mn, max(timestamp) mx from midi_events")
    .get() as { c: number; mn: number | null; mx: number | null };
  console.log(`db: ${path}`);
  console.log(`events: ${tot.c}`);
  if (tot.mn && tot.mx) {
    console.log(`span:   ${new Date(tot.mn).toISOString()} -> ${new Date(tot.mx).toISOString()}`);
  }
  const days = db
    .query(
      "select date(timestamp/1000,'unixepoch','localtime') d, count(*) c from midi_events group by d order by d desc limit 7"
    )
    .all() as { d: string; c: number }[];
  console.log("recent days:");
  for (const r of days) console.log(`  ${r.d}: ${r.c}`);
} else if (cmd === "range") {
  const start = Number(process.argv[3]);
  const end = Number(process.argv[4]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    console.error("usage: range <startMs> <endMs>");
    process.exit(1);
  }
  const r = db
    .query(
      "select count(*) c, min(timestamp) mn, max(timestamp) mx from midi_events where timestamp>=? and timestamp<=?"
    )
    .get(start, end);
  console.log(JSON.stringify(r));
} else {
  console.error("usage: db-inspect.ts stats | range <startMs> <endMs>");
  process.exit(1);
}
