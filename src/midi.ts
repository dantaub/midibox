import { readdir } from "node:fs/promises";
import { recordEvent, type MidiEvent } from "./db";

type MidiEventCallback = (event: MidiEvent) => void;

const listeners: Set<MidiEventCallback> = new Set();
let inputReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let captureActive = false;

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

// Get expected message length based on status byte
function getMidiMessageLength(status: number): number {
  const type = status & 0xf0;
  switch (type) {
    case 0x80: // Note Off
    case 0x90: // Note On
    case 0xa0: // Poly Aftertouch
    case 0xb0: // Control Change
    case 0xe0: // Pitch Bend
      return 3;
    case 0xc0: // Program Change
    case 0xd0: // Channel Pressure
      return 2;
    case 0xf0: // System messages
      if (status === 0xf0) return -1; // SysEx - variable length
      if (status === 0xf1 || status === 0xf3) return 2;
      if (status === 0xf2) return 3;
      return 1; // Real-time messages
    default:
      return 0;
  }
}

function parseMidiMessage(data: Uint8Array): Omit<MidiEvent, "timestamp"> | null {
  if (data.length === 0) return null;

  const status = data[0];
  const channel = status & 0x0f;
  const type = status & 0xf0;

  switch (type) {
    case 0x90: // Note On
      return {
        channel,
        type: data[2] > 0 ? "noteon" : "noteoff",
        note: data[1],
        velocity: data[2],
      };
    case 0x80: // Note Off
      return {
        channel,
        type: "noteoff",
        note: data[1],
        velocity: data[2],
      };
    case 0xb0: // Control Change
      return {
        channel,
        type: "cc",
        control: data[1],
        value: data[2],
      };
    case 0xe0: // Pitch Bend
      return {
        channel,
        type: "pitchbend",
        value: (data[2] << 7) | data[1],
      };
    case 0xc0: // Program Change
      return {
        channel,
        type: "program",
        value: data[1],
      };
    case 0xd0: // Channel Pressure
      return {
        channel,
        type: "pressure",
        value: data[1],
      };
    case 0xa0: // Poly Aftertouch
      return {
        channel,
        type: "polytouch",
        note: data[1],
        value: data[2],
      };
    default:
      // Store raw data for unknown messages
      return {
        channel: 0,
        type: "raw",
        data: new Uint8Array(data),
      };
  }
}

// Find raw MIDI devices in /dev/snd/
export async function listInputs(): Promise<string[]> {
  try {
    const files = await readdir("/dev/snd");
    return files
      .filter((f) => f.startsWith("midi"))
      .map((f) => `/dev/snd/${f}`);
  } catch {
    return [];
  }
}

export async function listOutputs(): Promise<string[]> {
  // Same devices can be used for output
  return listInputs();
}

export async function startCapture(devicePath?: string): Promise<string> {
  const devices = await listInputs();

  if (devices.length === 0) {
    throw new Error("No MIDI devices found in /dev/snd/");
  }

  // Use specified device or first available (prefer midiC*D* format)
  let selectedDevice = devicePath;
  if (!selectedDevice) {
    // Prefer midiC*D* devices over midi* devices
    selectedDevice = devices.find((d) => d.includes("midiC")) || devices[0];
  }

  console.log(`Opening raw MIDI input: ${selectedDevice}`);

  captureActive = true;

  // Read from device using Bun's file streaming
  // We need to use a subprocess since Bun.file() doesn't support blocking device reads well
  const proc = Bun.spawn(["cat", selectedDevice], {
    stdout: "pipe",
    stderr: "ignore",
  });

  // Process MIDI data from the device
  const reader = proc.stdout.getReader();
  let buffer: number[] = [];
  let expectedLength = 0;
  let runningStatus = 0;

  (async () => {
    try {
      while (captureActive) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const byte of value) {
          // Handle status byte
          if (byte & 0x80) {
            // New status byte (not a data byte)
            if (byte >= 0xf8) {
              // Real-time message (clock, active sensing, etc.) - skip storing
              // These are too frequent and not useful for playback
              continue;
            }

            // Start new message
            buffer = [byte];
            runningStatus = byte;
            expectedLength = getMidiMessageLength(byte);
          } else {
            // Data byte
            if (buffer.length === 0 && runningStatus) {
              // Running status - reuse previous status
              buffer = [runningStatus];
              expectedLength = getMidiMessageLength(runningStatus);
            }
            buffer.push(byte);
          }

          // Check if message is complete
          if (expectedLength > 0 && buffer.length >= expectedLength) {
            const parsed = parseMidiMessage(new Uint8Array(buffer));
            if (parsed) {
              const event: MidiEvent = {
                timestamp: Date.now(),
                ...parsed,
              };
              recordEvent(event);
              notifyListeners(event);
            }
            buffer = [];
          }
        }
      }
    } catch (err) {
      if (captureActive) {
        console.error("MIDI read error:", err);
      }
    } finally {
      reader.releaseLock();
      proc.kill();
    }
  })();

  inputReader = reader;

  return selectedDevice;
}

export async function stopCapture(): Promise<void> {
  captureActive = false;
  if (inputReader) {
    try {
      inputReader.releaseLock();
    } catch {}
    inputReader = null;
  }
}

let outputDevice: string | null = null;

export async function openOutput(devicePath?: string): Promise<string> {
  const devices = await listOutputs();

  if (devices.length === 0) {
    throw new Error("No MIDI output devices found");
  }

  outputDevice = devicePath || devices[0];
  console.log(`Opening raw MIDI output: ${outputDevice}`);

  return outputDevice;
}

export function sendMidiMessage(data: number[]): void {
  if (!outputDevice) {
    throw new Error("MIDI output not open");
  }
  Bun.write(outputDevice, new Uint8Array(data));
}

export function playEvent(event: MidiEvent): void {
  if (!outputDevice) return;

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

  Bun.write(outputDevice, new Uint8Array(data));
}

export async function closeOutput(): Promise<void> {
  outputDevice = null;
}
