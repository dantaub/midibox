import { recordEvent, type MidiEvent } from "./db";

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
      return {
        channel,
        type: d2 > 0 ? "noteon" : "noteoff",
        note: d1,
        velocity: d2,
      };
    case 0x80: // Note Off
      return {
        channel,
        type: "noteoff",
        note: d1,
        velocity: d2,
      };
    case 0xb0: // Control Change
      return {
        channel,
        type: "cc",
        control: d1,
        value: d2,
      };
    case 0xe0: // Pitch Bend
      return {
        channel,
        type: "pitchbend",
        value: (d2 << 7) | d1,
      };
    case 0xc0: // Program Change
      return {
        channel,
        type: "program",
        value: d1,
      };
    case 0xd0: // Channel Pressure
      return {
        channel,
        type: "pressure",
        value: d1,
      };
    case 0xa0: // Poly Aftertouch
      return {
        channel,
        type: "polytouch",
        note: d1,
        value: d2,
      };
    default:
      return {
        channel: 0,
        type: "raw",
        data: new Uint8Array(data),
      };
  }
}

// ===========================================
// Platform-specific implementations
// ===========================================

// Linux: raw /dev/snd/ access
// macOS: CoreMIDI via JZZ library

let captureActive = false;
let inputReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let jzzInput: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let jzzOutput: any = null;
let outputDevice: string | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let JZZ: any = null;

async function getJZZ() {
  if (!isMacOS) return null;
  if (JZZ) return JZZ;
  try {
    const jzz = await import("jzz");
    JZZ = jzz.default;
    return JZZ;
  } catch (err) {
    console.error("Failed to load JZZ:", err);
    return null;
  }
}

// ===========================================
// List Devices
// ===========================================

export async function listInputs(): Promise<string[]> {
  if (isMacOS) {
    const jzz = await getJZZ();
    if (!jzz) return [];

    try {
      const info = await jzz().refresh();
      const inputs = info.info().inputs;
      return inputs.map((i: { name: string }) => i.name);
    } catch (err) {
      console.error("Failed to list MIDI inputs:", err);
      return [];
    }
  } else {
    // Linux: raw device files
    try {
      const { readdir } = await import("node:fs/promises");
      const files = await readdir("/dev/snd");
      return files
        .filter((f) => f.startsWith("midi"))
        .map((f) => `/dev/snd/${f}`);
    } catch {
      return [];
    }
  }
}

export async function listOutputs(): Promise<string[]> {
  if (isMacOS) {
    const jzz = await getJZZ();
    if (!jzz) return [];

    try {
      const info = await jzz().refresh();
      const outputs = info.info().outputs;
      return outputs.map((o: { name: string }) => o.name);
    } catch (err) {
      console.error("Failed to list MIDI outputs:", err);
      return [];
    }
  } else {
    return listInputs();
  }
}

// ===========================================
// Input Capture
// ===========================================

export async function startCapture(devicePath?: string): Promise<string> {
  if (isMacOS) {
    return startCaptureMacOS(devicePath);
  } else {
    return startCaptureLinux(devicePath);
  }
}

async function startCaptureMacOS(deviceName?: string): Promise<string> {
  const jzz = await getJZZ();
  if (!jzz) {
    throw new Error("JZZ not available");
  }

  const engine = await jzz();
  const info = engine.info();

  if (info.inputs.length === 0) {
    throw new Error("No MIDI input devices found");
  }

  // Find port by name or use first available
  let selectedName = info.inputs[0].name;
  if (deviceName) {
    const found = info.inputs.find((i: { name: string }) => i.name === deviceName);
    if (found) {
      selectedName = found.name;
    }
  }

  console.log(`Opening CoreMIDI input: ${selectedName}`);

  const port = await engine.openMidiIn(selectedName);

  port.connect((msg: number[]) => {
    // Skip real-time messages
    if (!msg[0] || msg[0] >= 0xf8) return;

    const parsed = parseMidiMessage(msg);
    if (parsed) {
      const event: MidiEvent = {
        timestamp: Date.now(),
        ...parsed,
      };
      recordEvent(event);
      notifyListeners(event);
    }
  });

  jzzInput = port;
  captureActive = true;

  return selectedName;
}

async function startCaptureLinux(devicePath?: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");

  let devices: string[];
  try {
    const files = await readdir("/dev/snd");
    devices = files
      .filter((f) => f.startsWith("midi"))
      .map((f) => `/dev/snd/${f}`);
  } catch {
    devices = [];
  }

  if (devices.length === 0) {
    throw new Error("No MIDI devices found in /dev/snd/");
  }

  const selectedDevice =
    devicePath ?? devices.find((d) => d.includes("midiC")) ?? devices[0]!;

  console.log(`Opening raw MIDI input: ${selectedDevice}`);

  captureActive = true;

  const proc = Bun.spawn(["cat", selectedDevice], {
    stdout: "pipe",
    stderr: "ignore",
  });

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
          if (byte & 0x80) {
            if (byte >= 0xf8) continue;
            buffer = [byte];
            runningStatus = byte;
            expectedLength = getMidiMessageLength(byte);
          } else {
            if (buffer.length === 0 && runningStatus) {
              buffer = [runningStatus];
              expectedLength = getMidiMessageLength(runningStatus);
            }
            buffer.push(byte);
          }

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

  // @ts-expect-error Bun's reader type differs slightly from standard
  inputReader = reader;
  return selectedDevice;
}

export async function stopCapture(): Promise<void> {
  captureActive = false;

  if (jzzInput) {
    try {
      jzzInput.close();
    } catch {}
    jzzInput = null;
  }

  if (inputReader) {
    try {
      inputReader.releaseLock();
    } catch {}
    inputReader = null;
  }
}

// ===========================================
// Output
// ===========================================

export async function openOutput(devicePath?: string): Promise<string> {
  if (isMacOS) {
    return openOutputMacOS(devicePath);
  } else {
    return openOutputLinux(devicePath);
  }
}

async function openOutputMacOS(deviceName?: string): Promise<string> {
  const jzz = await getJZZ();
  if (!jzz) {
    throw new Error("JZZ not available");
  }

  const engine = await jzz();
  const info = engine.info();

  if (info.outputs.length === 0) {
    throw new Error("No MIDI output devices found");
  }

  let selectedName = info.outputs[0].name;
  if (deviceName) {
    const found = info.outputs.find((o: { name: string }) => o.name === deviceName);
    if (found) {
      selectedName = found.name;
    }
  }

  console.log(`Opening CoreMIDI output: ${selectedName}`);
  const port = await engine.openMidiOut(selectedName);

  jzzOutput = port;
  outputDevice = selectedName;

  return selectedName;
}

async function openOutputLinux(devicePath?: string): Promise<string> {
  const devices = await listOutputs();

  if (devices.length === 0) {
    throw new Error("No MIDI output devices found");
  }

  const selected = devicePath ?? devices[0] ?? "";
  if (!selected) {
    throw new Error("No MIDI output devices found");
  }

  outputDevice = selected;
  console.log(`Opening raw MIDI output: ${outputDevice}`);

  return selected;
}

export function sendMidiMessage(data: number[]): void {
  if (isMacOS) {
    if (!jzzOutput) {
      throw new Error("MIDI output not open");
    }
    jzzOutput.send(data);
  } else {
    if (!outputDevice) {
      throw new Error("MIDI output not open");
    }
    Bun.write(outputDevice, new Uint8Array(data));
  }
}

export function playEvent(event: MidiEvent): void {
  if (isMacOS && !jzzOutput) return;
  if (!isMacOS && !outputDevice) return;

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

  sendMidiMessage(data);
}

export async function closeOutput(): Promise<void> {
  if (jzzOutput) {
    try {
      jzzOutput.close();
    } catch {}
    jzzOutput = null;
  }
  outputDevice = null;
}
