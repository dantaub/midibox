import { getRecent, getRange, createSession, listSessions, type MidiEvent, type Session } from "./db";
import { startCapture, stopCapture, listInputs, listOutputs, openOutput, onMidiEvent, playEvent, closeOutput } from "./midi";

const PORT = 4000;

// Track connected WebSocket clients for real-time updates
const wsClients: Set<ServerWebSocket<unknown>> = new Set();

// Broadcast MIDI events to all connected clients
onMidiEvent((event) => {
  const message = JSON.stringify({ type: "midi", event });
  for (const ws of wsClients) {
    ws.send(message);
  }
});

type ServerWebSocket<T> = {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  data: T;
};

const server = Bun.serve({
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

    // GET /api/sessions
    if (path === "/sessions" && method === "GET") {
      const sessions = listSessions();
      return json(sessions);
    }

    // POST /api/sessions
    if (path === "/sessions" && method === "POST") {
      const body: Session = await req.json();
      const id = createSession(body);
      return json({ id }, 201);
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

    // POST /api/midi/start
    if (path === "/midi/start" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const inputName = await startCapture(body.input);
      return json({ status: "recording", input: inputName });
    }

    // POST /api/midi/stop
    if (path === "/midi/stop" && method === "POST") {
      await stopCapture();
      return json({ status: "stopped" });
    }

    // POST /api/playback/start
    if (path === "/playback/start" && method === "POST") {
      const body = await req.json();
      const { start, end, output } = body;
      
      // Open output if specified
      if (output) {
        await openOutput(output);
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

    return json({ error: "Not found" }, 404);
  } catch (err: any) {
    console.error("API error:", err);
    return json({ error: err.message }, 500);
  }
}

// Playback state
let playbackActive = false;
let playbackAbortController: AbortController | null = null;

function stopPlayback(): void {
  playbackActive = false;
  if (playbackAbortController) {
    playbackAbortController.abort();
    playbackAbortController = null;
  }
}

// Event playback with timing and WebSocket broadcast
async function playbackEvents(events: MidiEvent[], clients: Set<ServerWebSocket<unknown>>): Promise<void> {
  if (events.length === 0) return;

  stopPlayback(); // Stop any existing playback
  playbackActive = true;
  playbackAbortController = new AbortController();

  const startTime = events[0].timestamp;
  const endTime = events[events.length - 1].timestamp;
  const totalDuration = endTime - startTime;
  const playbackStart = Date.now();

  // Notify clients playback started
  const startMsg = JSON.stringify({ 
    type: "playback", 
    status: "started", 
    totalEvents: events.length,
    duration: totalDuration 
  });
  for (const ws of clients) ws.send(startMsg);

  try {
    for (let i = 0; i < events.length && playbackActive; i++) {
      const event = events[i];
      const targetTime = playbackStart + (event.timestamp - startTime);
      const delay = targetTime - Date.now();

      if (delay > 0) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, delay);
          playbackAbortController?.signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new Error('Playback stopped'));
          });
        });
      }

      if (!playbackActive) break;

      // Send MIDI to output device
      playEvent(event);

      // Broadcast to WebSocket clients for visualization
      const progress = totalDuration > 0 ? (event.timestamp - startTime) / totalDuration : 1;
      const msg = JSON.stringify({ 
        type: "playback-event", 
        event,
        progress,
        eventIndex: i,
        totalEvents: events.length
      });
      for (const ws of clients) ws.send(msg);
    }
  } catch (e) {
    // Playback was stopped
  }

  playbackActive = false;
  
  // Notify clients playback ended
  const endMsg = JSON.stringify({ type: "playback", status: "ended" });
  for (const ws of clients) ws.send(endMsg);
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
