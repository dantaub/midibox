// Pure setTimeout jitter microbench - separates timer accuracy from work-induced
// event-loop delay. If this reads low (sub-ms) but real playback lateness is
// high, the delay is work on the loop (e.g. a synchronous DB write per event),
// not the timers.
//
//   bun run scripts/timer-jitter.ts [intervalMs] [samples]
//   MIDIBOX_HOST=... ./scripts/remote.sh 'bun run scripts/timer-jitter.ts'

const interval = Number(process.argv[2] ?? 4);
const samples = Number(process.argv[3] ?? 300);

let prev = performance.now();
let max = 0;
let sum = 0;
let n = 0;

function tick(): void {
  const now = performance.now();
  const d = Math.abs(now - prev - interval);
  if (d > max) max = d;
  sum += d;
  prev = now;
  n++;
  if (n < samples) {
    setTimeout(tick, interval);
  } else {
    console.log(
      `setTimeout(${interval}) over ${samples}: avg |jitter| ${(sum / n).toFixed(2)} ms, max ${max.toFixed(2)} ms`
    );
  }
}

setTimeout(tick, interval);
