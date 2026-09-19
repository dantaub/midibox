import type { MidiTransport } from "./types";
import { midiMessageLength } from "./midi-bytes";
import dgram from "node:dgram";

// RTP-MIDI over UDP (RFC 6295 payload) without the AppleMIDI session handshake,
// which is what qmidinet / multimidicast speak. Two address forms:
//   rtpm:<group>:<port>   multicast (join the group, send + receive)
//   rtp:<host>:<port>     unicast (point to point)
// v1 emits one MIDI message per packet (no journal, no running status) and
// parses incoming MIDI lists back into individual messages.

const RTP_PAYLOAD_TYPE = 0x61; // 97, the value qmidinet/AppleMIDI use

// ---- Pure codec (exported for tests) ----------------------------------------

// Wrap one MIDI message in an RTP-MIDI packet.
export function encodeRtpMidi(
  bytes: number[],
  seq: number,
  ssrc: number,
  timestamp = 0
): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // V=2, no padding/extension/CSRC
  header[1] = RTP_PAYLOAD_TYPE; // M=0
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);

  const len = bytes.length;
  let cmd: Buffer;
  if (len < 16) {
    // Short header: B=0, no journal/delta; low nibble is the list length.
    cmd = Buffer.from([len & 0x0f, ...bytes]);
  } else {
    // Long header: B=1, 12-bit length across two bytes.
    cmd = Buffer.from([0x80 | ((len >> 8) & 0x0f), len & 0xff, ...bytes]);
  }
  return Buffer.concat([header, cmd]);
}

// Parse an RTP-MIDI packet into zero or more MIDI messages.
export function decodeRtpMidi(packet: Buffer | Uint8Array): number[][] {
  const pkt = Buffer.from(packet);
  if (pkt.length < 13) return [];

  let off = 12; // skip the fixed RTP header
  const flags = pkt[off++]!;

  let len: number;
  if (flags & 0x80) {
    // Long header: 12-bit length.
    if (off >= pkt.length) return [];
    len = ((flags & 0x0f) << 8) | pkt[off++]!;
  } else {
    len = flags & 0x0f;
  }

  const hasLeadingDelta = (flags & 0x20) !== 0; // Z bit
  const list = pkt.subarray(off, off + len);
  return parseMidiList(list, hasLeadingDelta);
}

// Walk a MIDI command list: an optional leading delta-time, then commands each
// preceded (after the first) by a variable-length delta-time we discard.
function parseMidiList(buf: Buffer, hasLeadingDelta: boolean): number[][] {
  const msgs: number[][] = [];
  let i = 0;
  let first = true;
  let runningStatus = 0;

  const skipVarlen = () => {
    while (i < buf.length && buf[i]! & 0x80) i++;
    i++; // final byte (high bit clear)
  };

  while (i < buf.length) {
    if (!first || hasLeadingDelta) skipVarlen();
    first = false;
    if (i >= buf.length) break;

    let status = buf[i]!;
    if (status & 0x80) {
      runningStatus = status;
      i++;
    } else {
      status = runningStatus;
      if (!status) break; // malformed
    }

    const total = midiMessageLength(status);
    if (total <= 0) break; // unknown/variable - bail rather than misframe
    const dataLen = total - 1;
    const msg = [status, ...Array.from(buf.subarray(i, i + dataLen))];
    i += dataLen;
    msgs.push(msg);
  }

  return msgs;
}

// ---- Transport --------------------------------------------------------------

function parseEndpoint(rest: string | undefined): { host: string; port: number } {
  // Split on the last colon so hostnames/IPv4 with a port work.
  const raw = rest ?? "225.0.0.37:21928";
  const colon = raw.lastIndexOf(":");
  const host = colon > 0 ? raw.slice(0, colon) : raw;
  const port = colon > 0 ? parseInt(raw.slice(colon + 1), 10) : 21928;
  if (!Number.isFinite(port)) throw new Error(`Bad RTP-MIDI endpoint: ${raw}`);
  return { host, port };
}

export function makeRtpMidiTransport(multicast: boolean): MidiTransport {
  return new RtpMidiTransport(multicast);
}

class RtpMidiTransport implements MidiTransport {
  readonly scheme: string;

  private inSocket: dgram.Socket | null = null;
  private outSocket: dgram.Socket | null = null;
  private target: { host: string; port: number } | null = null;
  private seq = 0;
  private readonly ssrc = (Math.random() * 0xffffffff) >>> 0;

  constructor(private readonly multicast: boolean) {
    this.scheme = multicast ? "rtpm" : "rtp";
  }

  private label(rest: string | undefined): string {
    const { host, port } = parseEndpoint(rest);
    return `${this.scheme}:${host}:${port}`;
  }

  async listInputs(): Promise<string[]> {
    return [this.label(undefined)];
  }
  async listOutputs(): Promise<string[]> {
    return [this.label(undefined)];
  }

  async openInput(
    id: string | undefined,
    onMessage: (bytes: number[]) => void
  ): Promise<string> {
    const { host, port } = parseEndpoint(id);
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(port, () => {
        try {
          if (this.multicast) socket.addMembership(host);
          socket.off("error", reject);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    socket.on("message", (msg) => {
      for (const bytes of decodeRtpMidi(msg)) onMessage(bytes);
    });
    socket.on("error", (err) => console.error("RTP-MIDI input error:", err));

    this.inSocket = socket;
    console.log(`Listening for RTP-MIDI on ${this.label(id)}`);
    return this.label(id);
  }

  async openOutput(id?: string): Promise<string> {
    this.target = parseEndpoint(id);
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    if (this.multicast) socket.setMulticastTTL?.(1);
    this.outSocket = socket;
    console.log(`Sending RTP-MIDI to ${this.label(id)}`);
    return this.label(id);
  }

  send(bytes: number[]): void {
    if (!this.outSocket || !this.target) throw new Error("MIDI output not open");
    const packet = encodeRtpMidi(bytes, this.seq++ & 0xffff, this.ssrc, Date.now() >>> 0);
    this.outSocket.send(packet, this.target.port, this.target.host, (err) => {
      if (err) console.error("RTP-MIDI send failed:", err);
    });
  }

  async closeInput(): Promise<void> {
    if (this.inSocket) {
      try {
        this.inSocket.close();
      } catch {}
      this.inSocket = null;
    }
  }

  async closeOutput(): Promise<void> {
    if (this.outSocket) {
      try {
        this.outSocket.close();
      } catch {}
      this.outSocket = null;
    }
    this.target = null;
  }
}
