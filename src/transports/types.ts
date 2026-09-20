// A MIDI transport is one way of moving raw MIDI bytes in and out of MidiBox:
// a local ALSA sequencer port, a raw /dev/snd device, CoreMIDI, an RTP-MIDI
// network endpoint, and so on. Each transport manages at most one open input
// and one open output at a time; src/midi.ts picks the active one(s) by scheme.
export interface MidiTransport {
  // The address scheme this transport answers to, e.g. "seq", "rawalsa",
  // "coremidi", "rtp", "rtpm". Device ids are written "<scheme>:<rest>".
  readonly scheme: string;

  // Human-readable device names available for input / output. For network
  // transports this is the configured endpoint rather than a hardware list.
  listInputs(): Promise<string[]>;
  listOutputs(): Promise<string[]>;

  // Open an input and deliver each complete MIDI message (status + data bytes,
  // no running status) to `onMessage`. `deltaTimeMs`, when the transport can
  // measure it (RtMidi does), is the gap since the previous message at the
  // driver layer - a ground truth for arrival timing, independent of JS
  // event-loop jitter. `id` is the scheme-less remainder of the address, or
  // undefined to pick a sensible default. Returns the opened name.
  openInput(
    id: string | undefined,
    onMessage: (bytes: number[], deltaTimeMs?: number) => void
  ): Promise<string>;

  // Open an output for sending. Returns the opened name.
  openOutput(id?: string): Promise<string>;

  // Send one MIDI message to the currently open output. Throws if none is open.
  send(bytes: number[]): void;

  closeInput(): Promise<void>;
  closeOutput(): Promise<void>;
}

// Split "<scheme>:<rest>" into its parts. A bare id (no known scheme prefix)
// yields { scheme: undefined, rest: id } so callers can apply a platform
// default. The rest keeps any further colons intact (RTP uses host:port).
export function parseAddress(
  id: string | undefined,
  knownSchemes: readonly string[]
): { scheme: string | undefined; rest: string | undefined } {
  if (!id) return { scheme: undefined, rest: undefined };
  const colon = id.indexOf(":");
  if (colon > 0) {
    const scheme = id.slice(0, colon);
    if (knownSchemes.includes(scheme)) {
      return { scheme, rest: id.slice(colon + 1) };
    }
  }
  return { scheme: undefined, rest: id };
}
