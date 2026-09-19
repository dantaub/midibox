import type { MidiTransport } from "./types";

// ALSA sequencer (Linux) / CoreMIDI (macOS) / WinMM (Windows) via RtMidi, the
// @julusian/midi native addon. Ports are addressed by stable NAME and resolved
// to the current index at open time, so replug/boot reordering no longer moves
// the device out from under us. On a PipeWire system the seq port is mediated
// by PipeWire, so other clients can share it - unlike the raw device path.
//
// The addon is loaded lazily so a machine that never selects this transport
// never pays the native load cost (and a missing/broken build only bites the
// user who asked for "seq").

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RtMidi: any = null;

async function getRtMidi() {
  if (RtMidi) return RtMidi;
  const mod: any = await import("@julusian/midi");
  RtMidi = mod.default ?? mod;
  return RtMidi;
}

function findPort(port: any, name: string | undefined): number {
  const count = port.getPortCount();
  if (count === 0) return -1;
  if (name) {
    // A named device that isn't present must fail, not silently open a
    // different one - callers rely on this to surface a bad selection.
    for (let i = 0; i < count; i++) {
      if (port.getPortName(i) === name) return i;
    }
    return -1;
  }
  return 0; // no name -> first available
}

export class RtMidiTransport implements MidiTransport {
  readonly scheme = "seq";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private input: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private output: any = null;

  async listInputs(): Promise<string[]> {
    const midi = await getRtMidi();
    const port = new midi.Input();
    try {
      const n = port.getPortCount();
      return Array.from({ length: n }, (_, i) => port.getPortName(i));
    } finally {
      port.closePort?.();
    }
  }

  async listOutputs(): Promise<string[]> {
    const midi = await getRtMidi();
    const port = new midi.Output();
    try {
      const n = port.getPortCount();
      return Array.from({ length: n }, (_, i) => port.getPortName(i));
    } finally {
      port.closePort?.();
    }
  }

  async openInput(
    id: string | undefined,
    onMessage: (bytes: number[]) => void
  ): Promise<string> {
    const midi = await getRtMidi();
    const port = new midi.Input();
    const idx = findPort(port, id);
    if (idx < 0) {
      port.closePort?.();
      throw new Error(id ? `MIDI input not found: ${id}` : "No MIDI input ports available");
    }

    const name = port.getPortName(idx);
    // Keep RtMidi's defaults: ignore sysex, timing and active sensing, matching
    // the real-time filtering the other transports do.
    port.on("message", (_deltaTime: number, message: number[]) => onMessage(message));
    port.openPort(idx);
    console.log(`Opening ALSA seq input: ${name}`);

    this.input = port;
    return name;
  }

  async openOutput(id?: string): Promise<string> {
    const midi = await getRtMidi();
    const port = new midi.Output();
    const idx = findPort(port, id);
    if (idx < 0) {
      port.closePort?.();
      throw new Error(id ? `MIDI output not found: ${id}` : "No MIDI output ports available");
    }

    const name = port.getPortName(idx);
    port.openPort(idx);
    console.log(`Opening ALSA seq output: ${name}`);

    this.output = port;
    return name;
  }

  send(bytes: number[]): void {
    if (!this.output) throw new Error("MIDI output not open");
    this.output.sendMessage(bytes);
  }

  async closeInput(): Promise<void> {
    if (this.input) {
      try {
        this.input.closePort();
      } catch {}
      this.input = null;
    }
  }

  async closeOutput(): Promise<void> {
    if (this.output) {
      try {
        this.output.closePort();
      } catch {}
      this.output = null;
    }
  }
}
