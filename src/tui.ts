import { type MidiEvent } from "./db";

// ANSI escape codes
const ESC = "\x1b";
const CLEAR = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

// Colors
const FG_WHITE = `${ESC}[37m`;
const FG_BLACK = `${ESC}[30m`;
const FG_RED = `${ESC}[91m`;
const FG_GREEN = `${ESC}[92m`;
const FG_YELLOW = `${ESC}[93m`;
const FG_BLUE = `${ESC}[94m`;
const FG_MAGENTA = `${ESC}[95m`;
const FG_CYAN = `${ESC}[96m`;
const FG_GRAY = `${ESC}[90m`;

const BG_WHITE = `${ESC}[47m`;
const BG_BLACK = `${ESC}[40m`;
const BG_RED = `${ESC}[101m`;

// Server connection
const SERVER_HOST = process.env.MIDIBOX_HOST || "localhost";
const SERVER_PORT = process.env.MIDIBOX_PORT || "4000";
const WS_URL = `ws://${SERVER_HOST}:${SERVER_PORT}/ws`;
const API_URL = `http://${SERVER_HOST}:${SERVER_PORT}/api`;

// Note tracking
const activeNotes = new Set<number>();
const recentEvents: MidiEvent[] = [];
const MAX_EVENTS = 20;

// Connection state
let connected = false;
let reconnecting = false;
let ws: WebSocket | null = null;

// Note names
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteName(note: number): string {
  const octave = Math.floor(note / 12) - 1;
  const name = NOTE_NAMES[note % 12];
  return `${name}${octave}`.padStart(4);
}

function isBlackKey(note: number): boolean {
  return [1, 3, 6, 8, 10].includes(note % 12);
}

// Piano rendering (2 octaves visible at a time, scrolls based on played notes)
let viewStartNote = 48; // Start at C3

function renderPiano(): string[] {
  const lines: string[] = [];
  const width = process.stdout.columns || 80;
  const keysToShow = Math.min(28, Math.floor(width / 3)); // 3 chars per white key
  
  // Adjust view if active notes are outside visible range
  const activeArray = Array.from(activeNotes);
  if (activeArray.length > 0) {
    const minActive = Math.min(...activeArray);
    const maxActive = Math.max(...activeArray);
    
    // Find the white key index for boundary calculations
    if (minActive < viewStartNote) {
      viewStartNote = Math.max(21, minActive - 5); // A0 minimum
    }
    if (maxActive > viewStartNote + keysToShow + 12) {
      viewStartNote = Math.min(96, maxActive - keysToShow);
    }
  }

  // Build piano display
  // Top row: black keys
  let blackKeyRow = " ";
  let whiteKeyTopRow = "";
  let whiteKeyMidRow = "";
  let whiteKeyBotRow = "";
  let labelRow = " ";
  
  let whiteKeyCount = 0;
  
  for (let note = viewStartNote; whiteKeyCount < keysToShow && note <= 108; note++) {
    if (isBlackKey(note)) {
      continue;
    }
    
    const isActive = activeNotes.has(note);
    const nextIsBlack = note < 108 && isBlackKey(note + 1);
    const blackActive = nextIsBlack && activeNotes.has(note + 1);
    
    // White key parts
    const whiteChar = isActive ? `${BG_RED}${FG_WHITE}` : `${BG_WHITE}${FG_BLACK}`;
    whiteKeyTopRow += `${whiteChar}   ${RESET}`;
    whiteKeyMidRow += `${whiteChar}   ${RESET}`;
    whiteKeyBotRow += `${whiteChar}   ${RESET}`;
    
    // Black key (sits on top)
    if (nextIsBlack) {
      const blackChar = blackActive ? `${BG_RED}${FG_WHITE}` : `${BG_BLACK}${FG_WHITE}`;
      blackKeyRow += ` ${blackChar}██${RESET}`;
    } else {
      blackKeyRow += "   ";
    }
    
    // Note label
    if (note % 12 === 0) {
      labelRow += `C${Math.floor(note / 12) - 1} `;
    } else {
      labelRow += "   ";
    }
    
    whiteKeyCount++;
  }
  
  lines.push(`${FG_GRAY}${labelRow}${RESET}`);
  lines.push(blackKeyRow);
  lines.push(whiteKeyTopRow);
  lines.push(whiteKeyMidRow);
  lines.push(whiteKeyBotRow);
  
  return lines;
}

function renderEventLog(): string[] {
  const lines: string[] = [];
  const height = Math.min(MAX_EVENTS, (process.stdout.rows || 24) - 12);
  const width = process.stdout.columns || 80;
  
  lines.push(`${BOLD}${FG_CYAN}━━━ Recent Events ━━━${RESET}`);
  
  const eventsToShow = recentEvents.slice(-height);
  
  for (const event of eventsToShow) {
    const time = new Date(event.timestamp).toLocaleTimeString();
    let line = `${FG_GRAY}${time}${RESET} `;
    
    switch (event.type) {
      case "noteon":
        line += `${FG_GREEN}NOTE ON ${RESET} ${BOLD}${noteName(event.note!)}${RESET} vel:${FG_BLUE}${event.velocity?.toString().padStart(3)}${RESET}`;
        break;
      case "noteoff":
        line += `${FG_RED}NOTE OFF${RESET} ${BOLD}${noteName(event.note!)}${RESET}`;
        break;
      case "cc":
        line += `${FG_YELLOW}CC${event.control?.toString().padStart(3)}${RESET}  val:${FG_BLUE}${event.value?.toString().padStart(3)}${RESET}`;
        break;
      case "pitchbend":
        line += `${FG_MAGENTA}BEND${RESET}     val:${FG_BLUE}${event.value?.toString().padStart(5)}${RESET}`;
        break;
      default:
        line += `${FG_GRAY}${event.type}${RESET}`;
    }
    
    // Clear rest of line to prevent artifacts
    line += `${ESC}[K`;
    lines.push(line);
  }
  
  // Pad with empty lines if needed
  while (lines.length < height + 1) {
    lines.push("");
  }
  
  return lines;
}

function renderStatus(): string[] {
  const now = new Date().toLocaleTimeString();
  const noteCount = activeNotes.size;
  
  let statusIcon: string;
  let statusMsg: string;
  
  if (connected) {
    statusIcon = `${FG_GREEN}●${RESET}`;
    statusMsg = "Connected to server";
  } else if (reconnecting) {
    statusIcon = `${FG_YELLOW}◌${RESET}`;
    statusMsg = "Reconnecting...";
  } else {
    statusIcon = `${FG_RED}○${RESET}`;
    statusMsg = "Disconnected";
  }
  
  return [
    "",
    `${BOLD}${FG_CYAN}━━━ MidiBox TUI ━━━${RESET}`,
    `${statusIcon} ${statusMsg} (${SERVER_HOST}:${SERVER_PORT})`,
    `${FG_GRAY}Time: ${now}  |  Active notes: ${noteCount}  |  Press Ctrl+C to exit${RESET}`,
  ];
}

function render(): void {
  const output: string[] = [];
  
  // Status header
  output.push(...renderStatus());
  output.push("");
  
  // Piano
  output.push(`${BOLD}${FG_CYAN}━━━ Piano ━━━${RESET}`);
  output.push(...renderPiano());
  output.push("");
  
  // Event log
  output.push(...renderEventLog());
  
  // Move cursor home and draw
  process.stdout.write(`${ESC}[H`);
  process.stdout.write(output.join("\n"));
}

function handleMidiEvent(event: MidiEvent): void {
  if (event.type === "realtime" || event.type === "raw") {
    return;
  }
  
  recentEvents.push(event);
  if (recentEvents.length > MAX_EVENTS * 2) {
    recentEvents.splice(0, MAX_EVENTS);
  }
  
  if (event.type === "noteon" && event.velocity && event.velocity > 0) {
    activeNotes.add(event.note!);
  } else if (event.type === "noteoff" || (event.type === "noteon" && event.velocity === 0)) {
    activeNotes.delete(event.note!);
  }
}

function connect(): void {
  reconnecting = true;
  
  try {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
      connected = true;
      reconnecting = false;
    };
    
    ws.onclose = () => {
      connected = false;
      ws = null;
      // Reconnect after delay
      setTimeout(connect, 2000);
    };
    
    ws.onerror = () => {
      // Will trigger onclose
    };
    
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data.toString());
        if (data.type === "midi") {
          handleMidiEvent(data.event);
        }
      } catch {
        // Ignore parse errors
      }
    };
  } catch {
    reconnecting = false;
    setTimeout(connect, 2000);
  }
}

async function loadRecentFromApi(): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/events/recent?minutes=5`);
    if (res.ok) {
      const events: MidiEvent[] = await res.json();
      const filtered = events.filter(e => e.type !== "realtime" && e.type !== "raw");
      recentEvents.push(...filtered.slice(-MAX_EVENTS));
    }
  } catch {
    // Server may not be running yet
  }
}

async function main() {
  // Setup terminal
  process.stdout.write(CLEAR);
  process.stdout.write(HIDE_CURSOR);
  
  // Handle resize
  process.stdout.on("resize", render);
  
  // Handle exit
  const cleanup = () => {
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write(CLEAR);
    console.log("MidiBox TUI stopped.");
    if (ws) ws.close();
    process.exit(0);
  };
  
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  
  // Load recent events from API
  await loadRecentFromApi();
  
  // Connect to server via WebSocket
  connect();
  
  // Initial render
  render();
  
  // Refresh display at 30fps
  setInterval(render, 33);
}

main().catch((err) => {
  process.stdout.write(SHOW_CURSOR);
  console.error("Error:", err.message);
  process.exit(1);
});
