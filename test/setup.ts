// Point every test at a throwaway database, never the real one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "midibox-test-"));
process.env.MIDIBOX_DB = join(dir, "test.db");

process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});
