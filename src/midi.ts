import { recordEvent, type MidiEvent } from "./db";
import type { MidiTransport } from "./transports/types";
import { resolveScheme } from "./transports/select";
import { RawAlsaTransport } from "./transports/rawalsa";
import { CoreMidiTransport } from "./transports/coremidi";
import { RtMidiTransport } from "./transports/rtmidi";
import { makeRtpMidiTransport } from "./transports/rtpmidi";

type MidiEventCallback = (event: MidiEvent) => void;

const listeners: Set<MidiEventCallback> = new Set();
const isMacOS = process.platform === "darwin";

export function onMidiEvent(callback: MidiEventCallback): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function notifyListeners(event: MidiEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("Error in MIDI event listener:", err);
    }
  }
}

// Parse a raw MIDI message (status + data bytes) into a storable event.
function parseMidiMessage(data: Uint8Array | number[]): Omit<MidiEvent, "timestamp"> | null {
  if (data.length < 1) return null;

  const status = data[0];
  if (status === undefined) return null;

  const channel = status & 0x0f;
  const type = status & 0xf0;
  const d1 = data[1] ?? 0;
  const d2 = data[2] ?? 0;

  switch (type) {
    case 0x90: // Note On
      return { channel, type: d2 > 0 ? "noteon" : "noteoff", note: d1, velocity: d2 };
    case 0x80: // Note Off
      return { channel, type: "noteoff", note: d1, velocity: d2 };
    case 0xb0: // Control Change
      return { channel, type: "cc", control: d1, value: d2 };
    case 0xe0: // Pitch Bend
      return { channel, type: "pitchbend", value: (d2 << 7) | d1 };
    case 0xc0: // Program Change
      return { channel, type: "program", value: d1 };
    case 0xd0: // Channel Pressure
      return { channel, type: "pressure", value: d1 };
    case 0xa0: // Poly Aftertouch
      return { channel, type: "polytouch", note: d1, value: d2 };
    default:
      return { channel: 0, type: "raw", data: new Uint8Array(data) };
  }
}

// ===========================================
// Transport registry
//
// Each scheme maps to a transport implementation. The active input and output
// share a cached instance per scheme (one holds an input and an output handle
// independently); MIDI thru gets its own fresh instance so it never fights the
// playback output for the single output handle.
// ===========================================

const registry: Record<string, () => MidiTransport> = {
  seq: () => new RtMidiTransport(),
  rawalsa: () => new RawAlsaTransport(),
  coremidi: () => new CoreMidiTransport(),
  rtp: () => makeRtpMidiTransport(false),
  rtpm: () => makeRtpMidiTransport(true),
};

const knownSchemes = Object.keys(registry);
const instances: Record<string, MidiTransport> = {};

function getTransport(scheme: string): MidiTransport {
  const make = registry[scheme];
  if (!make) throw new Error(`Unknown MIDI transport: ${scheme}`);
  return (instances[scheme] ??= make());
}

function platformDefault(): string {
  return isMacOS ? "coremidi" : "seq";
}

// Resolve an address into a scheme + the scheme-less remainder, defaulting to
// the platform's scheme. See resolveScheme (transports/select.ts) for the rules.
function resolve(id: string | undefined) {
  return resolveScheme(id, knownSchemes, platformDefault());
}

// ===========================================
// Active handles
// ===========================================

let activeInput: MidiTransport | null = null;
let activeOutput: MidiTransport | null = null;
let inputDevice: string | null = null;
let outputDevice: string | null = null;

// MIDI thru (independent output instance so it can't collide with playback)
let thruEnabled = false;
let thruTransport: MidiTransport | null = null;
let thruOutputDevice: string | null = null;

function forwardThru(bytes: number[]): void {
  if (!thruEnabled || !thruTransport) return;
  try {
    thruTransport.send(bytes);
  } catch (err) {
    console.error("MIDI thru send failed:", err);
  }
}

const CAPTURE_DEBUG = !!process.env.MIDIBOX_CAPTURE_DEBUG;
let captureLastStamp: number | null = null;

// The single sink for every captured message, whatever the transport.
// `deltaTimeMs`, when provided (RtMidi), is the driver-layer gap since the
// previous message - ground truth for arrival timing.
function handleIncoming(bytes: number[], deltaTimeMs?: number): void {
  const t0 = CAPTURE_DEBUG ? performance.now() : 0;
  forwardThru(bytes);
  const parsed = parseMidiMessage(bytes);
  if (parsed) {
    const timestamp = Date.now();
    const event: MidiEvent = { timestamp, ...parsed };
    recordEvent(event);
    notifyListeners(event);

    if (CAPTURE_DEBUG) {
      // storedΔ is the gap between the timestamps we actually record; compare it
      // to the driver-layer arrival gap (deltaTimeMs) to see how much the
      // capture path inflates a chord's spacing.
      const storedD = captureLastStamp === null ? 0 : timestamp - captureLastStamp;
      captureLastStamp = timestamp;
      const proc = performance.now() - t0;
      const rt = deltaTimeMs === undefined ? "?" : deltaTimeMs.toFixed(2);
      console.log(
        `[capture] arrivalΔ=${rt}ms storedΔ=${storedD}ms proc=${proc.toFixed(2)}ms ` +
          `${parsed.type}${parsed.note !== undefined ? " " + parsed.note : ""}`
      );
    }
  }
}

// ===========================================
// Device discovery
// ===========================================

export async function listInputs(): Promise<string[]> {
  const scheme = activeInput?.scheme ?? resolve(process.env.MIDIBOX_MIDI).scheme;
  return getTransport(scheme).listInputs();
}

export async function listOutputs(): Promise<string[]> {
  const scheme = activeOutput?.scheme ?? activeInput?.scheme ?? resolve(process.env.MIDIBOX_MIDI).scheme;
  return getTransport(scheme).listOutputs();
}

export function getTransportInfo() {
  return {
    schemes: knownSchemes,
    default: platformDefault(),
    input: activeInput?.scheme ?? null,
    output: activeOutput?.scheme ?? null,
  };
}

// ===========================================
// Input capture
// ===========================================

export async function startCapture(id?: string): Promise<string> {
  await stopCapture();

  const target = id ?? process.env.MIDIBOX_MIDI ?? undefined;
  const { scheme, rest, explicit } = resolve(target);

  try {
    const transport = getTransport(scheme);
    const name = await transport.openInput(rest, handleIncoming);
    activeInput = transport;
    inputDevice = name;
    return name;
  } catch (err) {
    // Only auto-fall back to raw ALSA when the caller didn't pin a scheme and we
    // were on the default seq path (per the requested behavior).
    if (!explicit && scheme === "seq") {
      console.warn(`ALSA seq input unavailable (${(err as Error).message}); falling back to raw ALSA`);
      const transport = getTransport("rawalsa");
      const name = await transport.openInput(rest, handleIncoming);
      activeInput = transport;
      inputDevice = name;
      return name;
    }
    throw err;
  }
}

export function getInputDevice(): string | null {
  return inputDevice;
}

export async function stopCapture(): Promise<void> {
  if (activeInput) {
    try {
      await activeInput.closeInput();
    } catch {}
    activeInput = null;
  }
  inputDevice = null;
}

// ===========================================
// Output
// ===========================================

export async function openOutput(id?: string): Promise<string> {
  if (activeOutput) {
    try {
      await activeOutput.closeOutput();
    } catch {}
    activeOutput = null;
  }

  // Default the output scheme to whatever the input is using, so a plain device
  // name picked in the UI opens on the same backend.
  const { scheme, rest } = resolveScheme(id, knownSchemes, activeInput?.scheme ?? platformDefault());

  const transport = getTransport(scheme);
  const name = await transport.openOutput(rest);
  activeOutput = transport;
  outputDevice = name;
  return name;
}

export function sendMidiMessage(data: number[]): void {
  if (!activeOutput) throw new Error("MIDI output not open");
  activeOutput.send(data);
}

export function playEvent(event: MidiEvent): void {
  if (!activeOutput) return;

  const channel = event.channel & 0x0f;
  let data: number[] = [];

  switch (event.type) {
    case "noteon":
      data = [0x90 | channel, event.note!, event.velocity!];
      break;
    case "noteoff":
      data = [0x80 | channel, event.note!, event.velocity ?? 0];
      break;
    case "cc":
      data = [0xb0 | channel, event.control!, event.value!];
      break;
    case "pitchbend":
      data = [0xe0 | channel, event.value! & 0x7f, (event.value! >> 7) & 0x7f];
      break;
    case "program":
      data = [0xc0 | channel, event.value!];
      break;
    default:
      return;
  }

  activeOutput.send(data);
}

export async function closeOutput(): Promise<void> {
  if (activeOutput) {
    try {
      await activeOutput.closeOutput();
    } catch {}
    activeOutput = null;
  }
  outputDevice = null;
}

/** Currently open MIDI output, or null when nothing is connected */
export function getOutputDevice(): string | null {
  return outputDevice;
}

// ===========================================
// MIDI Thru (forward input to output on its own instance)
// ===========================================

export async function enableThru(id?: string): Promise<string> {
  await disableThru();

  const { scheme, rest } = resolveScheme(id, knownSchemes, activeInput?.scheme ?? platformDefault());

  // Fresh instance so thru never shares the playback output handle.
  const transport = registry[scheme]?.();
  if (!transport) throw new Error(`Unknown MIDI transport: ${scheme}`);

  const name = await transport.openOutput(rest);
  thruTransport = transport;
  thruOutputDevice = name;
  thruEnabled = true;
  console.log(`Enabling MIDI thru to: ${name}`);
  return name;
}

export async function disableThru(): Promise<void> {
  thruEnabled = false;
  if (thruTransport) {
    try {
      await thruTransport.closeOutput();
    } catch {}
    thruTransport = null;
  }
  thruOutputDevice = null;
}

export function isThruEnabled(): boolean {
  return thruEnabled;
}

export function getThruOutput(): string | null {
  return thruOutputDevice;
}
