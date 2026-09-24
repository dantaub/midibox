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
        if (JSON.parse(String(e.data)).type !== "pong") return; // e.g. the playback state sent on connect
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
    const messages: any[] = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "playback" && msg.status !== "state") {
        statuses.push(msg.status);
        messages.push(msg);
      }
    };
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("socket error"));
    });
    const count = (status: string) => statuses.filter((s) => s === status).length;
    const waitFor = async (status: string, times = 1) => {
      for (let i = 0; i < 60 && count(status) < times; i++) await Bun.sleep(50);
      return count(status) >= times;
    };
    return { ws, statuses, messages, waitFor };
  }

  const longEvents: MidiEvent[] = [
    { timestamp: DAY, channel: 0, type: "noteon", note: 60, velocity: 90 },
    { timestamp: DAY + 30_000, channel: 0, type: "noteoff", note: 60, velocity: 0 },
  ];

  test("stop announces the end, so clients leave the playing state", async () => {
    const { ws, messages, waitFor } = await watchPlayback();
    await post("/api/playback/start", { events: longEvents });
    expect(await waitFor("started")).toBe(true);

    await post("/api/playback/stop", {});
    expect(await waitFor("ended")).toBe(true);
    expect(messages.find((m) => m.status === "ended").stopped).toBe(true);
    ws.close();
  });

  test("playing through to the end says it wasn't stopped", async () => {
    const { ws, messages, waitFor } = await watchPlayback();
    await post("/api/playback/start", {
      events: [
        { timestamp: DAY, channel: 0, type: "noteon", note: 60, velocity: 90 },
        { timestamp: DAY + 100, channel: 0, type: "noteoff", note: 60, velocity: 0 },
      ],
    });
    expect(await waitFor("ended")).toBe(true);
    expect(messages.find((m) => m.status === "ended").stopped).toBe(false);
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

  const shortEvents: MidiEvent[] = [
    { timestamp: DAY, channel: 0, type: "noteon", note: 60, velocity: 90 },
    { timestamp: DAY + 100, channel: 0, type: "noteoff", note: 60, velocity: 0 },
  ];

  test("a looping clip restarts itself until loop is turned off", async () => {
    const { ws, messages, waitFor } = await watchPlayback();
    await post("/api/playback/start", { events: shortEvents, loop: true, title: "Short", key: "test:1" });
    expect(await waitFor("started", 3)).toBe(true);

    const starts = messages.filter((m) => m.status === "started");
    expect(starts[0].restart).toBe(false);
    expect(starts[1].restart).toBe(true);
    expect(starts[1].clip.id).toBeGreaterThan(starts[0].clip.id);
    expect(starts[1].clip.key).toBe("test:1");
    expect(messages.some((m) => m.status === "ended")).toBe(false);

    await post("/api/playback/loop", { loop: false });
    expect(await waitFor("ended")).toBe(true);
    expect(messages.find((m) => m.status === "ended").stopped).toBe(false);
    ws.close();
  });

  test("stop ends a looping clip", async () => {
    const { ws, messages, waitFor } = await watchPlayback();
    await post("/api/playback/start", { events: shortEvents, loop: true });
    expect(await waitFor("started", 2)).toBe(true);
    await post("/api/playback/stop", {});
    expect(await waitFor("ended")).toBe(true);
    expect(messages.find((m) => m.status === "ended").stopped).toBe(true);
    await post("/api/playback/loop", { loop: false });
    ws.close();
  });

  test("reports what's playing, and tells a new connection", async () => {
    expect((await (await api("/api/playback")).json()).status).toBe("idle");

    const { ws, waitFor } = await watchPlayback();
    await post("/api/playback/start", { events: longEvents, title: "Long", key: "test:2", source: "history" });
    expect(await waitFor("started")).toBe(true);

    const state = await (await api("/api/playback")).json();
    expect(state.status).toBe("playing");
    expect(state.clip).toMatchObject({ kind: "range", title: "Long", key: "test:2", source: "history", start: DAY, end: DAY + 30_000 });
    expect(state.position).toBeGreaterThanOrEqual(DAY);

    // A page connecting now hears about it straight away
    const late = new WebSocket(`ws://localhost:${PORT}/ws`);
    const first = await new Promise<any>((resolve) => { late.onmessage = (e) => resolve(JSON.parse(String(e.data))) });
    expect(first).toMatchObject({ type: "playback", status: "state", state: "playing", clip: { key: "test:2" } });
    late.close();

    await post("/api/playback/stop", {});
    expect(await waitFor("ended")).toBe(true);
    ws.close();
  });

  test("seek replays the current clip from a point, keeping loop and pause", async () => {
    const { ws, messages, waitFor } = await watchPlayback();
    await post("/api/playback/start", { events: longEvents, loop: true });
    expect(await waitFor("started")).toBe(true);
    await post("/api/playback/pause", {});
    expect(await waitFor("paused")).toBe(true);

    const res = await (await post("/api/playback/seek", { at: DAY + 10_000 })).json();
    expect(res.status).toBe("paused");
    expect(await waitFor("started", 2)).toBe(true);
    const second = messages.filter((m) => m.status === "started")[1];
    expect(second.from).toBe(DAY + 10_000);
    expect(second.loop).toBe(true);
    expect((await (await api("/api/playback")).json()).status).toBe("paused");

    await post("/api/playback/stop", {});
    expect(await waitFor("ended")).toBe(true);
    await post("/api/playback/loop", { loop: false });
    ws.close();
  });

  test("a looping clip with nothing to wait for still lets a stop through", async () => {
    const { ws, messages, waitFor } = await watchPlayback();
    // Both events due at once: a pass never sleeps
    await post("/api/playback/start", {
      loop: true,
      events: [
        { timestamp: DAY, channel: 0, type: "noteon", note: 60, velocity: 90 },
        { timestamp: DAY, channel: 0, type: "noteon", note: 64, velocity: 90 },
      ],
    });
    expect(await waitFor("started", 2)).toBe(true);
    const res = await Promise.race([post("/api/playback/stop", {}), Bun.sleep(2000).then(() => null)]);
    expect(res?.status).toBe(200);
    expect(await waitFor("ended")).toBe(true);
    expect(messages.find((m) => m.status === "ended").stopped).toBe(true);
    await post("/api/playback/loop", { loop: false });
    ws.close();
  });

  test("playing one file over another doesn't flash an end in between", async () => {
    const file = () => {
      const fd = new FormData();
      const bytes = writeMidiFile([
        { timestamp: 0, channel: 0, type: "noteon", note: 60, velocity: 90 },
        { timestamp: 20_000, channel: 0, type: "noteoff", note: 60, velocity: 0 },
      ] as MidiEvent[]);
      fd.append("file", new File([bytes], "t.mid", { type: "audio/midi" }));
      return fd;
    };
    const { ws, statuses, waitFor } = await watchPlayback();
    await api("/api/playback/file", { method: "POST", body: file() });
    expect(await waitFor("started")).toBe(true);
    await api("/api/playback/file", { method: "POST", body: file() });
    expect(await waitFor("started", 2)).toBe(true);
    await Bun.sleep(200);
    expect(statuses).toEqual(["started", "started"]);

    await post("/api/playback/stop", {});
    expect(await waitFor("ended")).toBe(true);
    ws.close();
  });

  test("seek with nothing playing is refused", async () => {
    expect((await post("/api/playback/seek", { at: 0 })).status).toBe(409);
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
