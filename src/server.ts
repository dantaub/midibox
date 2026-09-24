import { getRecent, getRange, createSession, listSessions, updateSessionById, deleteSessionById, getDaySummaries, getActivitySegments, getSessionsInRange, getSessionById, type MidiEvent, type Session } from "./db";
import { writeMidiFile } from "./midi-file-write";
import { startCapture, stopCapture, listInputs, listOutputs, openOutput, onMidiEvent, playEvent, closeOutput, sendMidiMessage, enableThru, disableThru, isThruEnabled, getThruOutput, getOutputDevice, getInputDevice, getTransportInfo, allNotesOff } from "./midi";
import { parseMidiFile, getPlayableEvents } from "./midi-file";

const PORT = Number(process.env.MIDIBOX_PORT ?? process.env.PORT ?? 4000) || 4000;

// Track connected WebSocket clients for real-time updates
const wsClients: Set<ServerWebSocket<unknown>> = new Set();

// Broadcast a message to every connected client
function broadcast(payload: unknown): void {
  const message = JSON.stringify(payload);
  for (const ws of wsClients) {
    ws.send(message);
  }
}

// Broadcast MIDI events to all connected clients
onMidiEvent((event) => {
  broadcast({ type: "midi", event });
});

type ServerWebSocket<T> = {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  data: T;
};

function serveOrExplain(options: Parameters<typeof Bun.serve>[0]) {
  try {
    return Bun.serve(options);
  } catch (err: any) {
    if (err?.code === "EACCES" && PORT < 1024) {
      console.error(`\nCannot bind port ${PORT}: ports below 1024 are privileged.\n`);
      console.error("Options:");
      console.error("  - systemd: the shipped unit grants CAP_NET_BIND_SERVICE, so reinstall");
      console.error("    with ./scripts/install-service.sh --force and set MIDIBOX_PORT there");
      console.error("  - allow it system-wide: sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80");
      console.error(`  - or redirect: keep MIDIBOX_PORT high and forward ${PORT} to it`);
      console.error("\nSee INSTALL.md - 'Privileged ports'.\n");
    } else if (err?.code === "EADDRINUSE") {
      console.error(`\nPort ${PORT} is already in use - another MidiBox, or something else.`);
      console.error("Stop it, or set MIDIBOX_PORT to a free port.\n");
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

const server = serveOrExplain({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // API routes
    if (url.pathname.startsWith("/api/")) {
      return handleApi(req, url);
    }

    // Serve static files
    return serveStatic(url.pathname);
  },

  websocket: {
    open(ws) {
      wsClients.add(ws as any);
      console.log(`WebSocket client connected (${wsClients.size} total)`);
      // Catch a page that just (re)connected up on whatever is playing
      const { status: state, ...rest } = playbackState();
      ws.send(JSON.stringify({ type: "playback", status: "state", state, ...rest }));
    },
    close(ws) {
      wsClients.delete(ws as any);
      console.log(`WebSocket client disconnected (${wsClients.size} total)`);
    },
    message(ws, message) {
      // Handle incoming WebSocket messages if needed
      try {
        const data = JSON.parse(message.toString());
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (data.type === "playNote") {
          // Send note on/off to MIDI output
          const { note, velocity, on } = data;
          const channel = 0;
          if (on) {
            sendMidiMessage([0x90 | channel, note, velocity || 100]);
          } else {
            sendMidiMessage([0x80 | channel, note, 0]);
          }
        } else if (data.type === "pedal") {
          // On-screen sustain pedal (CC 64), alongside the on-screen keys
          sendMidiMessage([0xb0, 64, data.down ? 127 : 0]);
        }
      } catch (e) {
        // Ignore invalid messages
      }
    },
  },
});

async function handleApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.replace("/api", "");
  const method = req.method;

  try {
    // GET /api/events/recent?minutes=5
    if (path === "/events/recent" && method === "GET") {
      const minutes = parseInt(url.searchParams.get("minutes") || "5");
      const since = Date.now() - minutes * 60 * 1000;
      const events = getRecent(since);
      return json(events);
    }

    // GET /api/events/range?start=...&end=...
    if (path === "/events/range" && method === "GET") {
      const start = parseInt(url.searchParams.get("start") || "0");
      const end = parseInt(url.searchParams.get("end") || String(Date.now()));
      const events = getRange(start, end);
      return json(events);
    }

    // GET /api/history/days?tz=<getTimezoneOffset()>[&limit=500]
    if (path === "/history/days" && method === "GET") {
      const tz = parseInt(url.searchParams.get("tz") || "0");
      const limit = parseInt(url.searchParams.get("limit") || "500");
      const days = getDaySummaries(Number.isFinite(tz) ? tz : 0, limit);
      return json(days);
    }

    // GET /api/history/segments?start=&end=[&gap=60000]
    if (path === "/history/segments" && method === "GET") {
      const start = parseInt(url.searchParams.get("start") || "0");
      const end = parseInt(url.searchParams.get("end") || String(Date.now()));
      const gap = parseInt(url.searchParams.get("gap") || "60000");
      const segments = getActivitySegments(start, end, Number.isFinite(gap) ? gap : 60000);
      return json({ start, end, segments, sessions: getSessionsInRange(start, end) });
    }

    // GET /api/sessions
    if (path === "/sessions" && method === "GET") {
      const sessions = listSessions();
      return json(sessions);
    }

    // GET /api/sessions/:id/export.mid - the session as a Standard MIDI File
    const exportMatch = path.match(/^\/sessions\/(\d+)\/export\.mid$/);
    if (exportMatch && method === "GET") {
      const id = parseInt(exportMatch[1]!, 10);
      const session = getSessionById(id);
      if (!session) return json({ error: "Session not found" }, 404);
      const events = getRange(session.start_time, session.end_time);
      const bytes = writeMidiFile(events);
      const name = (session.song_name || `session-${id}`).replace(/[^a-z0-9_-]+/gi, "_");
      return new Response(bytes, {
        headers: {
          "Content-Type": "audio/midi",
          "Content-Disposition": `attachment; filename="${name}.mid"`,
        },
      });
    }

    // POST /api/sessions
    if (path === "/sessions" && method === "POST") {
      const body: Session = await req.json();
      const id = createSession(body);
      return json({ id }, 201);
    }

    // PUT /api/sessions/:id
    if (path.match(/^\/sessions\/\d+$/) && method === "PUT") {
      const id = parseInt(path.split("/")[2]);
      const body: Session = await req.json();
      const success = updateSessionById(id, body);
      if (success) {
        return json({ success: true });
      }
      return json({ error: "Session not found" }, 404);
    }

    // DELETE /api/sessions/:id
    if (path.match(/^\/sessions\/\d+$/) && method === "DELETE") {
      const id = parseInt(path.split("/")[2]);
      const success = deleteSessionById(id);
      if (success) {
        return json({ success: true });
      }
      return json({ error: "Session not found" }, 404);
    }

    // GET /api/midi/transports - available transport schemes + which are active
    if (path === "/midi/transports" && method === "GET") {
      return json(getTransportInfo());
    }

    // GET /api/midi/inputs
    if (path === "/midi/inputs" && method === "GET") {
      const inputs = await listInputs();
      return json(inputs);
    }

    // GET /api/midi/outputs
    if (path === "/midi/outputs" && method === "GET") {
      const outputs = await listOutputs();
      return json(outputs);
    }

    // GET /api/midi/input - currently recording input
    if (path === "/midi/input" && method === "GET") {
      return json({ input: getInputDevice() });
    }

    // POST /api/midi/input { input } - switch the recording input device
    if (path === "/midi/input" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      await stopCapture();
      const inputName = await startCapture(body.input);
      broadcast({ type: "input", input: inputName });
      return json({ status: "recording", input: inputName });
    }

    // POST /api/midi/start
    if (path === "/midi/start" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const inputName = await startCapture(body.input);
      broadcast({ type: "input", input: inputName });
      return json({ status: "recording", input: inputName });
    }

    // POST /api/midi/stop
    if (path === "/midi/stop" && method === "POST") {
      await stopCapture();
      return json({ status: "stopped" });
    }

    // GET /api/midi/output - currently connected output
    if (path === "/midi/output" && method === "GET") {
      return json({ output: getOutputDevice() });
    }

    // POST /api/midi/output { output } - connect an output without playing
    if (path === "/midi/output" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const output = await openOutput(body.output);
      broadcast({ type: "output", output });
      return json({ status: "connected", output });
    }

    // DELETE /api/midi/output - disconnect
    if (path === "/midi/output" && method === "DELETE") {
      await closeOutput();
      broadcast({ type: "output", output: null });
      return json({ status: "disconnected" });
    }

    // GET /api/midi/thru - Get thru status
    if (path === "/midi/thru" && method === "GET") {
      return json({
        enabled: isThruEnabled(),
        output: getThruOutput()
      });
    }

    // POST /api/midi/thru - Enable thru
    if (path === "/midi/thru" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const outputName = await enableThru(body.output);
      return json({ status: "enabled", output: outputName });
    }

    // DELETE /api/midi/thru - Disable thru
    if (path === "/midi/thru" && method === "DELETE") {
      await disableThru();
      return json({ status: "disabled" });
    }

    // GET /api/playback - what's playing (or not), for a page that just loaded
    if (path === "/playback" && method === "GET") {
      return json(playbackState());
    }

    // POST /api/playback/start - play recorded events [start, end] (or, for
    // older callers, a client-supplied `events` list) as the current clip
    if (path === "/playback/start" && method === "POST") {
      const body: any = await req.json();
      const { start, end, output, events: providedEvents } = body;

      // Stop and silence any current playback FIRST, on its still-open output,
      // before we touch the output device below.
      const handover = handOver();
      try {
        await useOutput(output);
      } catch (err) {
        handover.fail();
        throw err;
      }
      if (!handover.stillOurs()) return json({ status: "stopped" });
      if (typeof body.loop === "boolean") loopEnabled = body.loop;

      const events: MidiEvent[] = providedEvents ?? getRange(start, end);
      const clip = makeClip({
        kind: "range",
        title: optString(body.title),
        key: optString(body.key),
        source: optString(body.source),
        events,
      });
      const from = optNumber(body.from) ?? clip.start;
      runClip(clip, from); // plays in the background, streaming events to clients

      return json({ status: "playing", clip: clipMeta(current), eventCount: events.length, duration: clip.end - clip.start });
    }

    // POST /api/playback/stop
    if (path === "/playback/stop" && method === "POST") {
      stopPlayback();
      return json({ status: "stopped" });
    }

    // POST /api/playback/pause - hold playback (silences held notes)
    if (path === "/playback/pause" && method === "POST") {
      const changed = setPlaybackPaused(true);
      if (changed) broadcastPlayback("paused", { position: playbackPosition() });
      return json({ status: "paused" });
    }

    // POST /api/playback/resume - continue a paused playback
    if (path === "/playback/resume" && method === "POST") {
      const changed = setPlaybackPaused(false);
      if (changed) broadcastPlayback("resumed", { position: playbackPosition() });
      return json({ status: "resumed" });
    }

    // POST /api/playback/loop { loop } - loop the current clip (and later ones)
    if (path === "/playback/loop" && method === "POST") {
      const body: any = await req.json();
      loopEnabled = !!body.loop;
      broadcastPlayback("loop");
      return json({ loop: loopEnabled });
    }

    // POST /api/playback/seek { at } - play the current clip from clip time `at`
    if (path === "/playback/seek" && method === "POST") {
      const body: any = await req.json();
      const at = optNumber(body.at);
      if (!current) return json({ error: "Nothing is playing" }, 409);
      if (at == null) return json({ error: "at is required" }, 400);
      const wasPaused = playbackPaused;
      runClip(current, at);
      if (wasPaused && setPlaybackPaused(true)) broadcastPlayback("paused", { position: playbackPosition() });
      return json({ status: wasPaused ? "paused" : "playing", clip: clipMeta(current) });
    }

    // POST /api/midi/file/parse - parse a MIDI file to events for preview (not stored)
    if (path === "/midi/file/parse" && method === "POST") {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      if (!file) return json({ error: "No file provided" }, 400);
      // Shaped like recorded events (timestamp = ms from start) so the piano-roll
      // and score render them the same way.
      const { midiFile, events } = fileEvents(await file.arrayBuffer());
      return json({
        fileName: file.name,
        durationMs: midiFile.durationMs,
        format: midiFile.format,
        tracks: midiFile.trackCount,
        events,
      });
    }

    // POST /api/playback/file - upload a MIDI file and play it as the current clip
    // (form fields: file, output?, title?, key?, source?, from?, loop?)
    if (path === "/playback/file" && method === "POST") {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      if (!file) {
        return json({ error: "No file provided" }, 400);
      }

      // Stop + silence any current playback on its still-open output first.
      const handover = handOver();
      let parsed: ReturnType<typeof fileEvents>;
      try {
        await useOutput(formData.get("output"));
        parsed = fileEvents(await file.arrayBuffer());
      } catch (err) {
        handover.fail();
        throw err;
      }
      if (!handover.stillOurs()) return json({ status: "stopped" });
      const loop = formData.get("loop");
      if (loop === "true" || loop === "false") loopEnabled = loop === "true";
      const { midiFile, events } = parsed;
      console.log(`Playing MIDI file: ${file.name}, ${events.length} events, ${Math.round(midiFile.durationMs / 1000)}s`);

      const clip = makeClip({
        kind: "file",
        title: optString(formData.get("title")) ?? file.name,
        key: optString(formData.get("key")),
        source: optString(formData.get("source")),
        start: 0,
        events,
      });
      runClip(clip, optNumber(formData.get("from")) ?? 0);

      return json({
        status: "playing",
        clip: clipMeta(current),
        fileName: file.name,
        eventCount: events.length,
        duration: midiFile.durationMs,
        format: midiFile.format,
        tracks: midiFile.trackCount
      });
    }

    return json({ error: "Not found" }, 404);
  } catch (err: any) {
    console.error("API error:", err);
    return json({ error: err.message }, 500);
  }
}

// Playback state
let playbackActive = false;
let playbackAbortController: AbortController | null = null;

// Pause: the scheduler runs on a virtual clock that stops advancing while
// paused (pausedTotalMs accumulates), so timing after resume stays aligned.
let playbackPaused = false;
let pausedTotalMs = 0;
let pauseStartedAt = 0;
let pauseWaiters: Array<() => void> = [];

function wakePauseWaiters(): void {
  const waiters = pauseWaiters;
  pauseWaiters = [];
  for (const w of waiters) w();
}

function setPlaybackPaused(paused: boolean): boolean {
  if (!playbackActive || paused === playbackPaused) return false;
  if (paused) {
    playbackPaused = true;
    pauseStartedAt = Date.now();
    allNotesOff(); // silence held notes for the duration of the pause
  } else {
    pausedTotalMs += Date.now() - pauseStartedAt;
    playbackPaused = false;
    wakePauseWaiters();
  }
  return true;
}

function stopPlayback(): void {
  const wasPlaying = playbackActive || playbackAbortController !== null;
  playbackActive = false;
  playbackPaused = false;
  wakePauseWaiters(); // let a loop parked at the pause gate exit
  if (playbackAbortController) {
    playbackAbortController.abort();
    playbackAbortController = null;
  }
  // Silence notes whose note-off never got sent (stopped mid-note). Runs
  // synchronously before the aborted loop resumes, so no straggler follows.
  if (wasPlaying) allNotesOff();
}

// Events whose scheduled time is within this window of "now" are sent as one
// burst, so a chord's notes go out back-to-back on one wake-up instead of on
// separate timer ticks. Kept small so it groups near-coincident events without
// quantizing the performance's micro-timing.
const PLAYBACK_BATCH_EPSILON_MS = 2;
const PLAYBACK_DEBUG = !!process.env.MIDIBOX_PLAYBACK_DEBUG;

// setTimeout that rejects when playback is stopped. The abort listener is
// removed on normal wake-up so one doesn't accumulate per batch.
function abortableSleep(ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = playbackAbortController?.signal;
    let timeout: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Playback stopped"));
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Core scheduler shared by recorded-range and MIDI-file playback. Audio timing
// is the priority: all MIDI due at a wake-up is emitted back-to-back BEFORE any
// WebSocket work, so serialization never sits between two note sends. The
// WebSocket feed is visual-only and tolerant to tens of ms.
async function runTimedPlayback<T>(
  items: T[],
  offsetMs: (item: T) => number,
  emit: (item: T) => void,
  payload: (item: T, index: number) => string,
  clients: Set<ServerWebSocket<unknown>>
): Promise<void> {
  const playStartWall = Date.now();
  pausedTotalMs = 0;
  playbackPaused = false;
  // Virtual clock: wall time minus time spent paused. Doesn't advance while
  // parked at the pause gate, so scheduled offsets stay aligned after resume.
  const virtualNow = () =>
    Date.now() - playStartWall - pausedTotalMs - (playbackPaused ? Date.now() - pauseStartedAt : 0);
  passClock = virtualNow;
  const lateness: number[] = [];
  let batches = 0;
  let i = 0;

  try {
    while (i < items.length && playbackActive) {
      // Park here while paused (woken by resume or stop).
      while (playbackPaused && playbackActive) {
        await new Promise<void>((res) => pauseWaiters.push(res));
      }
      if (!playbackActive) break;

      // Sleep toward the next event, in <=100ms chunks so a pause/stop is
      // noticed promptly; short waits (chords) still sleep their exact length.
      const wait = offsetMs(items[i]!) - virtualNow();
      if (wait > PLAYBACK_BATCH_EPSILON_MS) {
        await abortableSleep(Math.min(wait, 100));
        continue;
      }

      // Drain everything now due (plus a small look-ahead) into one batch.
      const now = virtualNow();
      const start = i;
      while (i < items.length && offsetMs(items[i]!) <= now + PLAYBACK_BATCH_EPSILON_MS) {
        i++;
      }

      // Audio first.
      for (let k = start; k < i; k++) emit(items[k]!);

      const late = now - offsetMs(items[start]!);
      lateness.push(late);
      batches++;
      if (PLAYBACK_DEBUG) {
        console.log(`[playback] batch ${batches}: ${i - start} event(s), ${late.toFixed(1)} ms late`);
      }

      // Visual second.
      for (let k = start; k < i; k++) {
        const msg = payload(items[k]!, k);
        for (const ws of clients) ws.send(msg);
      }
    }
  } catch {
    // Playback was stopped (abortableSleep rejected) or an emit failed.
  }

  if (lateness.length) {
    const avg = lateness.reduce((s, x) => s + x, 0) / lateness.length;
    const max = Math.max(...lateness);
    console.log(
      `[playback] done: ${items.length} events in ${batches} batches; ` +
        `scheduling lateness avg ${avg.toFixed(1)} ms, max ${max.toFixed(1)} ms`
    );
  }
}

// ---- Clip player ------------------------------------------------------------
// One clip plays at a time, whoever started it. The server remembers what it
// is (so every client can show and control it) and loops it itself, so a loop
// keeps going when the page that started it sleeps or closes.

interface Clip {
  id: number;             // bumped on every pass/start, so clients can spot a restart
  kind: "range" | "file"; // range: recorded events (DB time); file: an import (ms from 0)
  title: string | null;
  key: string | null;     // the client's item key, e.g. "session:3", "import:7"
  source: string | null;  // which view started it ("live", "history", "io")
  start: number;          // clip time of the first event (file: 0)
  end: number;            // clip time of the last event
  events: MidiEvent[];    // timestamp = clip time
}

let current: Clip | null = null;
const MIN_LOOP_PASS_MS = 250;
let clipSeq = 0;
let loopEnabled = false;  // survives between clips: arm it, then press play
let passFrom = 0;         // clip time the running pass started from
let passClock: (() => number) | null = null; // ms into the running pass (paused time excluded)

type ClipInit = Omit<Clip, "id" | "start" | "end"> & { start?: number };

function makeClip(init: ClipInit): Clip {
  const evs = init.events;
  const start = init.start ?? (evs.length ? evs[0]!.timestamp : 0);
  const end = evs.length ? Math.max(start, evs[evs.length - 1]!.timestamp) : start;
  return { ...init, id: 0, start, end };
}

function clipMeta(clip: Clip | null) {
  if (!clip) return null;
  const { id, kind, title, key, source, start, end } = clip;
  return { id, kind, title, key, source, start, end };
}

// Estimated clip-time position of what's playing, or null when idle
function playbackPosition(): number | null {
  if (!current) return null;
  return Math.min(current.end, passFrom + (passClock ? passClock() : 0));
}

function playbackState() {
  return {
    status: !current ? "idle" : playbackPaused ? "paused" : "playing",
    clip: clipMeta(current),
    loop: loopEnabled,
    position: playbackPosition(),
  };
}

// Every playback status message carries the clip and the loop setting.
function broadcastPlayback(status: string, extra: Record<string, unknown> = {}): void {
  broadcast({ type: "playback", status, clip: clipMeta(current), loop: loopEnabled, ...extra });
}

// Events from `at` on, led by the sustain pedal's state at `at`, so starting
// mid-clip inside a pedalled passage still sounds (and draws) pedalled.
function sliceFrom(events: MidiEvent[], at: number): MidiEvent[] {
  let pedal: MidiEvent | null = null;
  let i = 0;
  for (; i < events.length && events[i]!.timestamp < at; i++) {
    const e = events[i]!;
    if (e.type === "cc" && e.control === 64) pedal = e;
  }
  const rest = events.slice(i);
  return pedal ? [{ ...pedal, timestamp: at }, ...rest] : rest;
}

// True when another playback has started since `mine` did. A plain stop
// clears the controller to null rather than replacing it, and that playback
// still has to announce "ended" or clients never leave the playing state.
function supersededBy(mine: AbortController): boolean {
  return playbackAbortController !== null && playbackAbortController !== mine;
}

// Stop what's playing ahead of starting something else, for a start request
// that still has to wait (for the output, or the uploaded file). A placeholder
// controller makes the old clip's run bow out quietly, so clients see one
// "started" follow another instead of an "ended" flashing in between.
// `stillOurs()` after the waits: false when a stop (or another start) came in
// meanwhile - then the request should give up, and after a stop, clients are
// told it ended. `fail()` hands back if the start fails.
function handOver() {
  stopPlayback();
  const placeholder = new AbortController();
  playbackAbortController = placeholder;
  const endQuietly = () => {
    playbackActive = false;
    current = null;
    broadcastPlayback("ended", { stopped: true });
  };
  return {
    stillOurs(): boolean {
      if (playbackAbortController === placeholder) return true;
      if (playbackAbortController === null) endQuietly(); // a stop came in
      return false;
    },
    fail(): void {
      if (playbackAbortController !== placeholder) return;
      playbackAbortController = null;
      endQuietly();
    },
  };
}

// Play `clip` from clip time `from`, then (while loop is on) again from its
// start, until it ends, is stopped, or another clip replaces it. Only the
// call that's still current announces "ended" - otherwise it would clobber
// the state of the playback that superseded it. `stopped` in that message
// tells a stop apart from playing through to the end.
async function runClip(clip: Clip, from: number): Promise<void> {
  stopPlayback();
  current = clip;
  playbackActive = true;
  const myController = new AbortController();
  playbackAbortController = myController;
  const span = Math.max(1, clip.end - clip.start);
  let restart = false;

  for (;;) {
    clip.id = ++clipSeq;
    const passStart = Math.max(clip.start, Math.min(from, clip.end));
    const slice = sliceFrom(clip.events, passStart);
    passFrom = passStart;
    passClock = null;
    const passWall = Date.now();
    broadcastPlayback("started", {
      totalEvents: slice.length,
      duration: clip.end - clip.start,
      from: passStart,
      restart,
    });

    await runTimedPlayback(
      slice,
      (e) => e.timestamp - passStart,
      (e) => playEvent(e),
      (e, index) =>
        JSON.stringify({
          type: "playback-event",
          event: e,
          clipId: clip.id,
          position: e.timestamp,
          progress: (e.timestamp - clip.start) / span,
          eventIndex: index,
          totalEvents: slice.length,
        }),
      wsClients
    );

    if (supersededBy(myController)) return;
    if (myController.signal.aborted || !loopEnabled || slice.length === 0) break;
    // Next pass from the top, from silence: nothing (pedal included) carries over.
    allNotesOff();
    // A real timer between passes: a clip whose events are all due at once
    // would otherwise loop on microtasks alone and starve every request, stop
    // included. And no pass repeats faster than MIN_LOOP_PASS_MS.
    try {
      await abortableSleep(Math.max(5, MIN_LOOP_PASS_MS - (Date.now() - passWall)));
    } catch {
      // stopped while waiting
    }
    if (supersededBy(myController)) return;
    if (myController.signal.aborted || !loopEnabled) break;
    from = clip.start;
    restart = true;
  }

  const stopped = myController.signal.aborted;
  playbackActive = false;
  current = null;
  passClock = null;
  broadcastPlayback("ended", { stopped });
}

// Opens the output when the request names one.
async function useOutput(output: unknown): Promise<void> {
  if (typeof output === "string" && output) {
    await openOutput(output);
    broadcast({ type: "output", output: getOutputDevice() });
  }
}

// A MIDI file's playable events, shaped like recorded ones (timestamp = ms from start)
function fileEvents(buffer: ArrayBuffer) {
  const midiFile = parseMidiFile(buffer);
  const events: MidiEvent[] = getPlayableEvents(midiFile).map((e) => ({
    timestamp: e.timeMs,
    channel: e.channel,
    type: e.type,
    note: e.note,
    velocity: e.velocity,
    control: e.control,
    value: e.value,
  }));
  return { midiFile, events };
}

const optString = (v: unknown) => (typeof v === "string" && v ? v : null);
const optNumber = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function serveStatic(pathname: string): Promise<Response> {
  // Default to index.html
  if (pathname === "/") pathname = "/index.html";

  const filePath = `${import.meta.dir}/../public${pathname}`;
  const file = Bun.file(filePath);

  if (await file.exists()) {
    return new Response(file);
  }

  // SPA fallback - serve index.html for non-API routes
  const indexFile = Bun.file(`${import.meta.dir}/../public/index.html`);
  if (await indexFile.exists()) {
    return new Response(indexFile);
  }

  return new Response("Not found", { status: 404 });
}

console.log(`🎹 MidiBox server running at http://localhost:${PORT}`);

// Auto-start MIDI capture on launch
startCapture()
  .then((input) => console.log(`🎵 Recording from: ${input}`))
  .catch((err) => console.log(`⚠️  No MIDI input available: ${err.message}`));

export { server };
