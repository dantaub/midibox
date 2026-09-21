import { getRecent, getRange, createSession, listSessions, updateSessionById, deleteSessionById, getDaySummaries, getActivitySegments, getSessionsInRange, getSessionById, type MidiEvent, type Session } from "./db";
import { writeMidiFile } from "./midi-file-write";
import { startCapture, stopCapture, listInputs, listOutputs, openOutput, onMidiEvent, playEvent, closeOutput, sendMidiMessage, enableThru, disableThru, isThruEnabled, getThruOutput, getOutputDevice, getInputDevice, getTransportInfo, allNotesOff } from "./midi";
import { parseMidiFile, getPlayableEvents, type MidiFileEvent } from "./midi-file";

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

    // POST /api/playback/start
    if (path === "/playback/start" && method === "POST") {
      const body = await req.json();
      const { start, end, output } = body;

      // Stop and silence any current playback FIRST, on its still-open output,
      // before we touch the output device below.
      stopPlayback();

      // Open output if specified
      if (output) {
        await openOutput(output);
        broadcast({ type: "output", output: getOutputDevice() });
      }

      // Get events and play them back
      const events = getRange(start, end);
      
      // Start playback in background, streaming events to clients
      playbackEvents(events, wsClients);
      
      return json({ status: "playing", eventCount: events.length, duration: events.length > 0 ? events[events.length - 1].timestamp - events[0].timestamp : 0 });
    }

    // POST /api/playback/stop
    if (path === "/playback/stop" && method === "POST") {
      stopPlayback();
      return json({ status: "stopped" });
    }

    // POST /api/playback/pause - hold playback (silences held notes)
    if (path === "/playback/pause" && method === "POST") {
      const changed = setPlaybackPaused(true);
      if (changed) broadcast({ type: "playback", status: "paused" });
      return json({ status: "paused" });
    }

    // POST /api/playback/resume - continue a paused playback
    if (path === "/playback/resume" && method === "POST") {
      const changed = setPlaybackPaused(false);
      if (changed) broadcast({ type: "playback", status: "resumed" });
      return json({ status: "resumed" });
    }

    // POST /api/midi/file/parse - parse a MIDI file to events for preview (not stored)
    if (path === "/midi/file/parse" && method === "POST") {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      if (!file) return json({ error: "No file provided" }, 400);
      const midiFile = parseMidiFile(await file.arrayBuffer());
      // Shape like recorded events (timestamp = ms from start) so the piano-roll
      // and score render them the same way.
      const events = getPlayableEvents(midiFile).map((e) => ({
        timestamp: e.timeMs,
        channel: e.channel,
        type: e.type,
        note: e.note,
        velocity: e.velocity,
        control: e.control,
        value: e.value,
      }));
      return json({
        fileName: file.name,
        durationMs: midiFile.durationMs,
        format: midiFile.format,
        tracks: midiFile.trackCount,
        events,
      });
    }

    // POST /api/playback/file - Upload and play a MIDI file
    if (path === "/playback/file" && method === "POST") {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      const outputDevice = formData.get("output") as string;
      
      if (!file) {
        return json({ error: "No file provided" }, 400);
      }

      // Stop + silence any current playback on its still-open output first.
      stopPlayback();

      // Open output if specified
      if (outputDevice) {
        await openOutput(outputDevice);
      }

      // Parse MIDI file
      const buffer = await file.arrayBuffer();
      const midiFile = parseMidiFile(buffer);
      const events = getPlayableEvents(midiFile);

      console.log(`Playing MIDI file: ${file.name}, ${events.length} events, ${Math.round(midiFile.durationMs / 1000)}s`);

      // Start playback
      playbackMidiFile(events, wsClients);

      return json({ 
        status: "playing", 
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
  const virtualNow = () => Date.now() - playStartWall - pausedTotalMs;
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

function broadcastPlaybackStart(
  clients: Set<ServerWebSocket<unknown>>,
  totalEvents: number,
  duration: number
): void {
  const msg = JSON.stringify({ type: "playback", status: "started", totalEvents, duration });
  for (const ws of clients) ws.send(msg);
}

function broadcastPlaybackEnd(clients: Set<ServerWebSocket<unknown>>): void {
  const msg = JSON.stringify({ type: "playback", status: "ended" });
  for (const ws of clients) ws.send(msg);
}

// Playback of a recorded range at its original timing.
async function playbackEvents(events: MidiEvent[], clients: Set<ServerWebSocket<unknown>>): Promise<void> {
  if (events.length === 0) {
    // Nothing to play (e.g. a seek landing past the last note) - still tell
    // clients so they don't sit forever thinking playback is still active.
    broadcastPlaybackEnd(clients);
    return;
  }

  stopPlayback();
  playbackActive = true;
  const myController = new AbortController();
  playbackAbortController = myController;

  const startTime = events[0]!.timestamp;
  const totalDuration = events[events.length - 1]!.timestamp - startTime;

  broadcastPlaybackStart(clients, events.length, totalDuration);

  await runTimedPlayback(
    events,
    (e) => e.timestamp - startTime,
    (e) => playEvent(e),
    (e, index) =>
      JSON.stringify({
        type: "playback-event",
        event: e,
        progress: totalDuration > 0 ? (e.timestamp - startTime) / totalDuration : 1,
        eventIndex: index,
        totalEvents: events.length,
      }),
    clients
  );

  // A newer seek/playback call may have superseded this one (its
  // AbortController replaced ours) while we were unwinding from the abort.
  // Only the call that's still current gets to clear playbackActive and
  // announce "ended" - otherwise we'd clobber the state of the playback
  // that superseded us and the client would see a spurious stop.
  if (playbackAbortController === myController) {
    playbackActive = false;
    broadcastPlaybackEnd(clients);
  }
}

// Translate one parsed MIDI-file event into a wire message and send it.
function emitFileEvent(event: MidiFileEvent): void {
  const channel = event.channel & 0x0f;
  switch (event.type) {
    case "noteon":
      sendMidiMessage([0x90 | channel, event.note!, event.velocity!]);
      break;
    case "noteoff":
      sendMidiMessage([0x80 | channel, event.note!, event.velocity || 0]);
      break;
    case "cc":
      sendMidiMessage([0xb0 | channel, event.control!, event.value!]);
      break;
    case "pitchbend":
      sendMidiMessage([0xe0 | channel, event.value! & 0x7f, (event.value! >> 7) & 0x7f]);
      break;
    case "program":
      sendMidiMessage([0xc0 | channel, event.value!]);
      break;
  }
}

// Playback of a parsed MIDI file (offsets are ms from the start).
async function playbackMidiFile(events: MidiFileEvent[], clients: Set<ServerWebSocket<unknown>>): Promise<void> {
  if (events.length === 0) return;

  stopPlayback();
  playbackActive = true;
  const myController = new AbortController();
  playbackAbortController = myController;

  const totalDuration = events[events.length - 1]!.timeMs;

  broadcastPlaybackStart(clients, events.length, totalDuration);

  await runTimedPlayback(
    events,
    (e) => e.timeMs,
    emitFileEvent,
    (e, index) =>
      JSON.stringify({
        type: "playback-event",
        event: {
          timestamp: Date.now(),
          channel: e.channel,
          type: e.type,
          note: e.note,
          velocity: e.velocity,
          control: e.control,
          value: e.value,
        },
        progress: totalDuration > 0 ? e.timeMs / totalDuration : 1,
        eventIndex: index,
        totalEvents: events.length,
      }),
    clients
  );

  if (playbackAbortController === myController) {
    playbackActive = false;
    broadcastPlaybackEnd(clients);
  }
}

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
