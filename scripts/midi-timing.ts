// MIDI timing probe - measures how far apart "simultaneous" notes actually
// arrive, and separates the protocol floor from any software-added spread.
//
//   bun run scripts/midi-timing.ts [port-name-substring] [chord-window-ms]
//
// Play chords (all notes down at once), several times. Note-ons that land
// within the chord window (default 30 ms) of each other are treated as one
// gesture; on Ctrl-C it reports the average spread of a chord - i.e. how much
// latency there is between the first and last note of a "simultaneous" strike.
//
// For each message it also prints three deltas from the previous message:
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
const CHORD_WINDOW_MS = Number(process.argv[3] ?? 30) || 30;
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

// Chord clustering: consecutive note-ons within CHORD_WINDOW_MS are one gesture.
// A gesture is finalized when the next note-on is too far off, or after a short
// idle gap (so the last chord reports even if Ctrl-C's handler never runs).
const isNoteOn = (b: number[]) => ((b[0] ?? 0) & 0xf0) === 0x90 && (b[2] ?? 0) > 0;
const IDLE_CLOSE_MS = 250;
let chord: number[] = []; // receive times (ms) of note-ons in the current gesture
let lastNoteOnRecv: number | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const chordSpreads: number[] = []; // first->last note spread per chord (>=2 notes)
const chordSizes: number[] = [];

function closeChord(): void {
  if (chord.length >= 2) {
    const spread = chord[chord.length - 1]! - chord[0]!;
    chordSpreads.push(spread);
    chordSizes.push(chord.length);
    const runningAvg = chordSpreads.reduce((s, x) => s + x, 0) / chordSpreads.length;
    console.log(
      `  >> chord: ${chord.length} notes, spread ${spread.toFixed(2)} ms, ` +
        `per-note ${(spread / (chord.length - 1)).toFixed(2)} ms   ` +
        `(avg spread over ${chordSpreads.length}: ${runningAvg.toFixed(2)} ms)`
    );
  }
  chord = [];
}

console.log(`Listening on: ${targetName}`);
console.log(`Chord window: ${CHORD_WINDOW_MS} ms. Play chords a few times, Ctrl-C for a summary.\n`);
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

  if (isNoteOn(msg)) {
    const tRecv = Number(hr) / 1e6;
    if (lastNoteOnRecv !== null && tRecv - lastNoteOnRecv > CHORD_WINDOW_MS) closeChord();
    chord.push(tRecv);
    lastNoteOnRecv = tRecv;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(closeChord, IDLE_CLOSE_MS);
  }

  if (count > 0) {
    recvDeltas.push(dRecv);
    rtDeltas.push(dRt);
  }
  count++;

  const mark = count > 1 && dRt < CHORD_WINDOW_MS ? "  <- same gesture?" : "";
  console.log(
    `  ${String(count).padStart(2)}  ${describe(msg).padEnd(15)}  ` +
      `${dRt.toFixed(3).padStart(7)}  ${dRecv.toFixed(3).padStart(9)}  ${String(dNow).padStart(8)}${mark}`
  );
});

input.openPort(openIdx);

const summary = () => {
  closeChord(); // finalize the gesture in progress
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const max = (a: number[]) => (a.length ? Math.max(...a) : 0);

  console.log(`\n${count} messages. Inter-message deltas (excluding the first):`);
  console.log(`  RtMidi (protocol floor): avg ${avg(rtDeltas).toFixed(3)} ms, max ${max(rtDeltas).toFixed(3)} ms`);
  console.log(`  Received (our callback): avg ${avg(recvDeltas).toFixed(3)} ms, max ${max(recvDeltas).toFixed(3)} ms`);
  console.log(`  Software added on average: ${(avg(recvDeltas) - avg(rtDeltas)).toFixed(3)} ms`);

  console.log(`\nChord latency (note-ons within ${CHORD_WINDOW_MS} ms grouped as one gesture):`);
  if (chordSpreads.length === 0) {
    console.log("  No multi-note chords detected - play a few chords and try again.");
  } else {
    const avgSpread = avg(chordSpreads);
    const avgSize = avg(chordSizes);
    // Per-note latency: spread shared across the gaps between notes in a chord.
    const perNote = chordSpreads.reduce((s, sp, i) => s + sp / (chordSizes[i]! - 1), 0) / chordSpreads.length;
    console.log(`  chords: ${chordSpreads.length}   avg notes/chord: ${avgSize.toFixed(1)}`);
    console.log(`  avg first->last spread: ${avgSpread.toFixed(2)} ms   (max ${max(chordSpreads).toFixed(2)} ms)`);
    console.log(`  avg per-note latency:   ${perNote.toFixed(2)} ms`);
  }

  try {
    input.closePort();
    input.destroy();
  } catch {}
  process.exit(0);
};

process.on("SIGINT", summary);
