// MIDI timing probe - measures how far apart "simultaneous" notes actually
// arrive, and separates the protocol floor from any software-added spread.
//
//   bun run scripts/midi-timing.ts [port-name-substring]
//
// Play a chord (all notes down at once). For each incoming message it prints
// three deltas from the previous message:
//
//   dRt    RtMidi's deltaTime, measured at the ALSA/RtMidi layer - the closest
//          thing to "when the bytes actually arrived". This is the protocol +
//          driver floor.
//   dRecv  a high-resolution clock (process.hrtime) read inside our callback -
//          dRt plus whatever the JS event loop added getting to us.
//   dNow   the millisecond Date.now() delta - what MidiBox currently records.
//          If two notes share a chord but land on different ms here, that's the
//          1 ms-granularity effect, not the hardware.
//
// Interpreting it:
//   - dRt ~= 1 ms per note, steady            -> serial MIDI protocol (hardware
//                                                floor; nothing to fix in code)
//   - dRecv >> dRt, or jittery                -> software/event-loop latency
//   - dRt tiny but dNow jumps a whole ms      -> Date.now() granularity in the
//                                                recording, fixable with a
//                                                higher-resolution timestamp

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod: any = await import("@julusian/midi");
const midi = mod.default ?? mod;

const OWN_CLIENT = /RtMidi (Input|Output) Client/;
const names: string[] = midi.Input.getPortNames().filter((n: string) => !OWN_CLIENT.test(n));

if (names.length === 0) {
  console.error("No MIDI input ports found.");
  process.exit(1);
}

const wanted = process.argv[2];
const idxInList = wanted ? names.findIndex((n) => n.includes(wanted)) : 0;
if (idxInList < 0) {
  console.error(`No input matching "${wanted}". Available:\n  ${names.join("\n  ")}`);
  process.exit(1);
}
const targetName = names[idxInList]!;

// Resolve the filtered name back to its real index on the input.
const input = new midi.Input();
let openIdx = -1;
for (let i = 0; i < input.getPortCount(); i++) {
  if (input.getPortName(i) === targetName) {
    openIdx = i;
    break;
  }
}
if (openIdx < 0) {
  console.error(`Could not resolve "${targetName}" to a port index.`);
  process.exit(1);
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const describe = (b: number[]): string => {
  const type = (b[0] ?? 0) & 0xf0;
  if (type === 0x90 || type === 0x80) {
    const note = b[1] ?? 0;
    const kind = type === 0x90 && (b[2] ?? 0) > 0 ? "on " : "off";
    return `${kind} ${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1} v${b[2] ?? 0}`;
  }
  return b.map((x) => x.toString(16).padStart(2, "0")).join(" ");
};

let prevHr: bigint | null = null;
let prevNow: number | null = null;
let count = 0;
const recvDeltas: number[] = [];
const rtDeltas: number[] = [];

console.log(`Listening on: ${targetName}`);
console.log("Play a chord (all notes at once). Ctrl-C for a summary.\n");
console.log("  #   message          dRt(ms)  dRecv(ms)  dNow(ms)");
console.log("  --  ---------------  -------  ---------  --------");

input.ignoreTypes(true, true, true); // sysex, timing, active sensing
input.on("message", (deltaTime: number, msg: number[]) => {
  const hr = process.hrtime.bigint();
  const now = Date.now();

  const dRt = deltaTime * 1000; // RtMidi reports seconds
  const dRecv = prevHr === null ? 0 : Number(hr - prevHr) / 1e6;
  const dNow = prevNow === null ? 0 : now - prevNow;
  prevHr = hr;
  prevNow = now;

  if (count > 0) {
    recvDeltas.push(dRecv);
    rtDeltas.push(dRt);
  }
  count++;

  const chord = count > 1 && dRt < 5 ? "  <- same gesture?" : "";
  console.log(
    `  ${String(count).padStart(2)}  ${describe(msg).padEnd(15)}  ` +
      `${dRt.toFixed(3).padStart(7)}  ${dRecv.toFixed(3).padStart(9)}  ${String(dNow).padStart(8)}${chord}`
  );
});

input.openPort(openIdx);

const summary = () => {
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const max = (a: number[]) => (a.length ? Math.max(...a) : 0);
  console.log(`\n${count} messages. Inter-message deltas (excluding the first):`);
  console.log(`  RtMidi (protocol floor): avg ${avg(rtDeltas).toFixed(3)} ms, max ${max(rtDeltas).toFixed(3)} ms`);
  console.log(`  Received (our callback): avg ${avg(recvDeltas).toFixed(3)} ms, max ${max(recvDeltas).toFixed(3)} ms`);
  const added = avg(recvDeltas) - avg(rtDeltas);
  console.log(`  Software added on average: ${added.toFixed(3)} ms`);
  try {
    input.closePort();
    input.destroy();
  } catch {}
  process.exit(0);
};

process.on("SIGINT", summary);
