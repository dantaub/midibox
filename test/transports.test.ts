import { test, expect, describe } from "bun:test";
import { parseAddress } from "../src/transports/types";
import { encodeRtpMidi, decodeRtpMidi } from "../src/transports/rtpmidi";

const schemes = ["seq", "rawalsa", "coremidi", "rtp", "rtpm"] as const;

describe("parseAddress", () => {
  test("splits an explicit scheme from its remainder", () => {
    expect(parseAddress("seq:USB Keyboard MIDI 1", schemes)).toEqual({
      scheme: "seq",
      rest: "USB Keyboard MIDI 1",
    });
  });

  test("keeps host:port intact for network schemes", () => {
    expect(parseAddress("rtpm:225.0.0.37:21928", schemes)).toEqual({
      scheme: "rtpm",
      rest: "225.0.0.37:21928",
    });
  });

  test("treats a bare device path as scheme-less", () => {
    expect(parseAddress("/dev/snd/midiC1D0", schemes)).toEqual({
      scheme: undefined,
      rest: "/dev/snd/midiC1D0",
    });
  });

  test("does not treat an unknown prefix as a scheme", () => {
    expect(parseAddress("bogus:thing", schemes)).toEqual({
      scheme: undefined,
      rest: "bogus:thing",
    });
  });

  test("undefined stays undefined", () => {
    expect(parseAddress(undefined, schemes)).toEqual({ scheme: undefined, rest: undefined });
  });
});

describe("RTP-MIDI codec", () => {
  const roundtrip = (bytes: number[]) => decodeRtpMidi(encodeRtpMidi(bytes, 1, 0xdeadbeef));

  test("round-trips a note-on", () => {
    expect(roundtrip([0x90, 60, 100])).toEqual([[0x90, 60, 100]]);
  });

  test("round-trips a control change", () => {
    expect(roundtrip([0xb0, 7, 127])).toEqual([[0xb0, 7, 127]]);
  });

  test("round-trips a 2-byte program change", () => {
    expect(roundtrip([0xc0, 5])).toEqual([[0xc0, 5]]);
  });

  test("round-trips a pitch bend", () => {
    expect(roundtrip([0xe0, 0x00, 0x40])).toEqual([[0xe0, 0x00, 0x40]]);
  });

  test("writes payload type 0x61 and the sequence/ssrc into the RTP header", () => {
    const pkt = encodeRtpMidi([0x90, 60, 100], 0x1234, 0xdeadbeef);
    expect(pkt[0]).toBe(0x80); // V=2
    expect(pkt[1]).toBe(0x61); // payload type 97
    expect(pkt.readUInt16BE(2)).toBe(0x1234);
    expect(pkt.readUInt32BE(8)).toBe(0xdeadbeef);
  });

  test("ignores a truncated packet", () => {
    expect(decodeRtpMidi(Buffer.from([0x80, 0x61, 0, 0]))).toEqual([]);
  });
});
