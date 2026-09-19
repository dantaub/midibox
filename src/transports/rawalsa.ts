import type { MidiTransport } from "./types";
import { midiMessageLength } from "./midi-bytes";

// Raw ALSA rawmidi: read a character device under /dev/snd directly. This is
// the original Linux path - single-reader, index-addressed - kept as a fallback
// for setups without the ALSA sequencer (see rtmidi.ts for the shareable,
// name-addressed transport that PipeWire can mediate).

async function listDevices(): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir("/dev/snd");
    return files.filter((f) => f.startsWith("midi")).map((f) => `/dev/snd/${f}`);
  } catch {
    return [];
  }
}

export class RawAlsaTransport implements MidiTransport {
  readonly scheme = "rawalsa";

  private captureActive = false;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private outputDevice: string | null = null;

  async listInputs(): Promise<string[]> {
    return listDevices();
  }

  async listOutputs(): Promise<string[]> {
    return listDevices();
  }

  async openInput(
    id: string | undefined,
    onMessage: (bytes: number[]) => void
  ): Promise<string> {
    const devices = await listDevices();
    if (devices.length === 0) {
      throw new Error("No MIDI devices found in /dev/snd/");
    }

    const selected = id ?? devices.find((d) => d.includes("midiC")) ?? devices[0]!;
    console.log(`Opening raw MIDI input: ${selected}`);

    this.captureActive = true;
    const proc = Bun.spawn(["cat", selected], { stdout: "pipe", stderr: "ignore" });
    this.proc = proc;

    const reader = proc.stdout.getReader();
    let buffer: number[] = [];
    let expectedLength = 0;
    let runningStatus = 0;

    (async () => {
      try {
        while (this.captureActive) {
          const { done, value } = await reader.read();
          if (done) break;

          for (const byte of value) {
            if (byte & 0x80) {
              if (byte >= 0xf8) continue; // real-time
              buffer = [byte];
              runningStatus = byte;
              expectedLength = midiMessageLength(byte);
            } else {
              if (buffer.length === 0 && runningStatus) {
                buffer = [runningStatus];
                expectedLength = midiMessageLength(runningStatus);
              }
              buffer.push(byte);
            }

            if (expectedLength > 0 && buffer.length >= expectedLength) {
              onMessage(buffer.slice(0, expectedLength));
              buffer = [];
            }
          }
        }
      } catch (err) {
        if (this.captureActive) console.error("MIDI read error:", err);
      } finally {
        try {
          reader.releaseLock();
        } catch {}
        proc.kill();
      }
    })();

    // @ts-expect-error Bun's reader type differs slightly from the DOM one
    this.reader = reader;
    return selected;
  }

  async openOutput(id?: string): Promise<string> {
    const devices = await listDevices();
    if (devices.length === 0) {
      throw new Error("No MIDI output devices found");
    }

    const selected = id ?? devices[0] ?? "";
    if (!selected) throw new Error("No MIDI output devices found");

    // Probe writability up front so a permission problem surfaces here rather
    // than silently dropping every note. 0xFE is Active Sensing - synths ignore it.
    try {
      await Bun.write(selected, new Uint8Array([0xfe]));
    } catch (err: any) {
      throw new Error(
        `Cannot write to MIDI output ${selected}: ${err?.message ?? err}. ` +
          `Check that the user running midibox is in the 'audio' group and that ` +
          `nothing else holds the device open.`
      );
    }

    this.outputDevice = selected;
    console.log(`Opening raw MIDI output: ${selected}`);
    return selected;
  }

  private lastOutputError = 0;

  send(bytes: number[]): void {
    if (!this.outputDevice) throw new Error("MIDI output not open");
    const device = this.outputDevice;
    // Bun.write() is async - report failures instead of leaving unhandled
    // rejections, which is how a broken output looked like silence.
    Bun.write(device, new Uint8Array(bytes)).catch((err: any) => {
      const now = Date.now();
      if (now - this.lastOutputError > 5000) {
        this.lastOutputError = now;
        console.error(`MIDI output write to ${device} failed: ${err?.message ?? err}`);
      }
    });
  }

  async closeInput(): Promise<void> {
    this.captureActive = false;
    if (this.reader) {
      try {
        this.reader.releaseLock();
      } catch {}
      this.reader = null;
    }
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {}
      this.proc = null;
    }
  }

  async closeOutput(): Promise<void> {
    this.outputDevice = null;
  }
}
