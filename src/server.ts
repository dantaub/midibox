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
      playbackEvents(events);
      
      return json({ status: "playing", eventCount: events.length });
    }

    return json({ error: "Not found" }, 404);
  } catch (err: any) {
    console.error("API error:", err);
    return json({ error: err.message }, 500);
  }
}

// Simple event playback with timing
async function playbackEvents(events: MidiEvent[]): Promise<void> {
  if (events.length === 0) return;

  const startTime = events[0].timestamp;
  const playbackStart = Date.now();

  for (const event of events) {
    const targetTime = playbackStart + (event.timestamp - startTime);
    const delay = targetTime - Date.now();

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    playEvent(event);
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
