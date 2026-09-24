// The HTTP API and WebSocket, against a real server on a throwaway database.
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMidiFile } from "../src/midi-file-write";
import type { MidiEvent } from "../src/db";

const dir = mkdtempSync(join(tmpdir(), "midibox-api-"));
const PORT = 4000 + Math.floor(Math.random() * 500) + 100;
const BASE_URL = `http://localhost:${PORT}`;
const DAY = Date.UTC(2026, 0, 15, 12, 0, 0);

let server: ReturnType<typeof Bun.spawn>;

const api = (path: string, init?: RequestInit) => fetch(`${BASE_URL}${path}`, init);
const post = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, MIDIBOX_PORT: String(PORT), MIDIBOX_DB: join(dir, "api.db") },
    stdout: "ignore",
    stderr: "ignore",
  });

  // Wait for it to accept connections
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE_URL}/api/sessions`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`server did not start on ${PORT}`);
});

afterAll(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("sessions", () => {
  test("create, read, update, delete", async () => {
    const created = await post("/api/sessions", {
      start_time: DAY,
      end_time: DAY + 60_000,
      song_name: "Prelude",
      performer: "Lily",
    });
    expect(created.status).toBe(201);
    const { id } = await created.json();

    const list = await (await api("/api/sessions")).json();
    expect(list.find((s: any) => s.id === id)).toMatchObject({ song_name: "Prelude", performer: "Lily" });

    const updated = await api(`/api/sessions/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_time: DAY, end_time: DAY + 30_000, song_name: "Prelude II" }),
    });
    expect(updated.status).toBe(200);

    expect((await api(`/api/sessions/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/api/sessions/${id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("history", () => {
  test("days and segments have the documented shape", async () => {
    const days = await (await api("/api/history/days?tz=0&limit=5")).json();
    expect(Array.isArray(days)).toBe(true);
    for (const day of days) {
      expect(day).toHaveProperty("date");
      expect(day).toHaveProperty("note_count");
      expect(day).toHaveProperty("session_count");
    }

    const history = await (await api(`/api/history/segments?start=${DAY}&end=${DAY + 60_000}`)).json();
    expect(history).toHaveProperty("segments");
    expect(history).toHaveProperty("sessions");
    expect(Array.isArray(history.segments)).toBe(true);
  });

  test("an unknown route is a 404, not a crash", async () => {
    expect((await api("/api/nope")).status).toBe(404);
  });
});

describe("midi output", () => {
  test("reports nothing connected on a fresh server", async () => {
    expect(await (await api("/api/midi/output")).json()).toEqual({ output: null });
  });

  test("connecting a device that isn't there fails with a message", async () => {
    const res = await post("/api/midi/output", { output: "/dev/snd/definitely-not-here" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBeTruthy();
  });

  test("thru reports its state", async () => {
    const thru = await (await api("/api/midi/thru")).json();
    expect(thru).toHaveProperty("enabled");
  });
});

describe("static files", () => {
  test("serves the UI", async () => {
    const html = await (await api("/")).text();
    expect(html).toContain("<title>MidiBox</title>");
    expect((await api("/app.js")).status).toBe(200);
    expect((await api("/history.js")).status).toBe(200);
  });
});

describe("websocket", () => {
  test("ping gets a pong", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no pong")), 5000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "ping" }));
      ws.onmessage = (e) => {
        clearTimeout(timer);
        resolve(String(e.data));
      };
      ws.onerror = () => reject(new Error("socket error"));
    });
    ws.close();
    expect(JSON.parse(reply).type).toBe("pong");
  });
});

describe("playback", () => {
  // Collects playback status messages from the WebSocket
  async function watchPlayback() {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const statuses: string[] = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "playback") statuses.push(msg.status);
    };
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("socket error"));
    });
    const waitFor = async (status: string) => {
      for (let i = 0; i < 50 && !statuses.includes(status); i++) await Bun.sleep(50);
      return statuses.includes(status);
    };
    return { ws, statuses, waitFor };
  }

  const longEvents: MidiEvent[] = [
    { timestamp: DAY, channel: 0, type: "noteon", note: 60, velocity: 90 },
    { timestamp: DAY + 30_000, channel: 0, type: "noteoff", note: 60, velocity: 0 },
  ];

  test("stop announces the end, so clients leave the playing state", async () => {
    const { ws, waitFor } = await watchPlayback();
    await post("/api/playback/start", { events: longEvents });
    expect(await waitFor("started")).toBe(true);

    await post("/api/playback/stop", {});
    expect(await waitFor("ended")).toBe(true);
    ws.close();
  });

  test("starting over a playback doesn't announce the old one's end", async () => {
    const { ws, statuses, waitFor } = await watchPlayback();
    await post("/api/playback/start", { events: longEvents });
    expect(await waitFor("started")).toBe(true);
    await post("/api/playback/start", { events: longEvents });
    await Bun.sleep(300);
    expect(statuses).toEqual(["started", "started"]);

    await post("/api/playback/stop", {});
    expect(await waitFor("ended")).toBe(true);
    ws.close();
  });
});

describe("midi file parse (import preview)", () => {
  test("parses an uploaded .mid into note events", async () => {
    const bytes = writeMidiFile([
      { timestamp: 0, channel: 0, type: "noteon", note: 60, velocity: 90 },
      { timestamp: 500, channel: 0, type: "noteoff", note: 60, velocity: 0 },
    ] as MidiEvent[]);
    const fd = new FormData();
    fd.append("file", new File([bytes], "t.mid", { type: "audio/midi" }));

    const res = await api("/api/midi/file/parse", { method: "POST", body: fd });
    expect(res.status).toBe(200);
    const data = await res.json();
    const ons = data.events.filter((e: any) => e.type === "noteon" && e.velocity > 0);
    expect(ons).toHaveLength(1);
    expect(ons[0].note).toBe(60);
    expect(ons[0].timestamp).toBe(0);
  });

  test("rejects a request with no file", async () => {
    const res = await api("/api/midi/file/parse", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
  });
});
