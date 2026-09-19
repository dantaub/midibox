import type { MidiTransport } from "./types";

// macOS CoreMIDI via the JZZ library. Ports are addressed by name, so this
// transport is already immune to the index churn that plagues rawalsa. Kept as
// the macOS default; Linux uses rtmidi/rawalsa instead.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let JZZ: any = null;

async function getJZZ() {
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

export class CoreMidiTransport implements MidiTransport {
  readonly scheme = "coremidi";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private input: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private output: any = null;

  async listInputs(): Promise<string[]> {
    const jzz = await getJZZ();
    if (!jzz) return [];
    try {
      const info = await jzz().refresh();
      return info.info().inputs.map((i: { name: string }) => i.name);
    } catch (err) {
      console.error("Failed to list MIDI inputs:", err);
      return [];
    }
  }

  async listOutputs(): Promise<string[]> {
    const jzz = await getJZZ();
    if (!jzz) return [];
    try {
      const info = await jzz().refresh();
      return info.info().outputs.map((o: { name: string }) => o.name);
    } catch (err) {
      console.error("Failed to list MIDI outputs:", err);
      return [];
    }
  }

  async openInput(
    id: string | undefined,
    onMessage: (bytes: number[]) => void
  ): Promise<string> {
    const jzz = await getJZZ();
    if (!jzz) throw new Error("JZZ not available");

    const engine = await jzz();
    const info = engine.info();
    if (info.inputs.length === 0) throw new Error("No MIDI input devices found");

    let name = info.inputs[0].name;
    if (id) {
      const found = info.inputs.find((i: { name: string }) => i.name === id);
      if (found) name = found.name;
    }

    console.log(`Opening CoreMIDI input: ${name}`);
    const port = await engine.openMidiIn(name);
    port.connect((msg: number[]) => {
      if (!msg[0] || msg[0] >= 0xf8) return; // skip real-time
      onMessage(msg);
    });

    this.input = port;
    return name;
  }

  async openOutput(id?: string): Promise<string> {
    const jzz = await getJZZ();
    if (!jzz) throw new Error("JZZ not available");

    const engine = await jzz();
    const info = engine.info();
    if (info.outputs.length === 0) throw new Error("No MIDI output devices found");

    let name = info.outputs[0].name;
    if (id) {
      const found = info.outputs.find((o: { name: string }) => o.name === id);
      if (found) name = found.name;
    }

    console.log(`Opening CoreMIDI output: ${name}`);
    this.output = await engine.openMidiOut(name);
    return name;
  }

  send(bytes: number[]): void {
    if (!this.output) throw new Error("MIDI output not open");
    this.output.send(bytes);
  }

  async closeInput(): Promise<void> {
    if (this.input) {
      try {
        this.input.close();
      } catch {}
      this.input = null;
    }
  }

  async closeOutput(): Promise<void> {
    if (this.output) {
      try {
        this.output.close();
      } catch {}
      this.output = null;
    }
  }
}
