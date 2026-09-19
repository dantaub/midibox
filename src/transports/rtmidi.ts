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

// MidiBox's own RtMidi ports self-list on ALSA ("RtMidi Input/Output Client").
// They are our capture/output clients, never a device the user should pick, so
// they're filtered out of the device lists.
const OWN_CLIENT = /RtMidi (Input|Output) Client/;
const realPorts = (names: string[]): string[] => names.filter((n) => !OWN_CLIENT.test(n));

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

  // Use the static enumerator, not `new Input()`: on ALSA, constructing an
  // Input/Output registers a sequencer client that lingers (RtMidi frees it only
  // on destroy(), and GC timing under Bun is unclear). Called on every dropdown
  // open/Refresh, that leaked a "RtMidi ... Client" per call - the phantom
  // entries this fixes.
  async listInputs(): Promise<string[]> {
    const midi = await getRtMidi();
    return realPorts(midi.Input.getPortNames());
  }

  async listOutputs(): Promise<string[]> {
    const midi = await getRtMidi();
    return realPorts(midi.Output.getPortNames());
  }

  async openInput(
    id: string | undefined,
    onMessage: (bytes: number[]) => void
  ): Promise<string> {
    const midi = await getRtMidi();
    const port = new midi.Input();
    const idx = findPort(port, id);
    if (idx < 0) {
      port.destroy?.();
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
      port.destroy?.();
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
      // destroy(), not just closePort(): releases the ALSA sequencer client so
      // switching devices doesn't leave a "RtMidi Input Client" behind.
      try {
        this.input.closePort();
      } catch {}
      try {
        this.input.destroy();
      } catch {}
      this.input = null;
    }
  }

  async closeOutput(): Promise<void> {
    if (this.output) {
      try {
        this.output.closePort();
      } catch {}
      try {
        this.output.destroy();
      } catch {}
      this.output = null;
    }
  }
}
