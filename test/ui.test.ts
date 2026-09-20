// Browser tests for the things that are easy to break and hard to notice:
// keyboard/timeline alignment, live mode not touching the database, the update
// rate, the direction flip, and nothing clipped at tablet sizes.
//
//   bun install                    # playwright-core is a devDependency
//   bun run test:ui
//
// Needs a Chromium build. Set CHROMIUM_PATH, or install one with
// `bunx playwright install chromium`. Without it these tests skip.
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function findChromium(): string | null {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_BROWSERS_PATH && `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium-1194/chrome-linux/chrome`,
    `${process.env.HOME}/.cache/ms-playwright/chromium-1194/chrome-linux/chrome`,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const chromiumPath = findChromium();
let playwright: typeof import("playwright-core") | null = null;
try {
  playwright = await import("playwright-core");
} catch {
  playwright = null;
}

const reason = !playwright ? "playwright-core not installed" : !chromiumPath ? "no Chromium found" : "";
if (reason) console.warn(`Skipping UI tests: ${reason}`);

const dir = mkdtempSync(join(tmpdir(), "midibox-ui-"));
const PORT = 4000 + Math.floor(Math.random() * 500) + 600;
const URL = `http://localhost:${PORT}/`;

let server: ReturnType<typeof Bun.spawn> | null = null;
let browser: any = null;

beforeAll(async () => {
  if (reason) return;

  server = Bun.spawn(["bun", "run", "index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, MIDIBOX_PORT: String(PORT), MIDIBOX_DB: join(dir, "ui.db") },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${URL}api/sessions`);
      break;
    } catch {
      await Bun.sleep(100);
    }
  }

  browser = await playwright!.chromium.launch({ executablePath: chromiumPath!, args: ["--no-sandbox"] });
});

afterAll(async () => {
  await browser?.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

// A page with a clean slate, failing the test on any console or page error
async function open(viewport = { width: 1280, height: 900 }) {
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(`page error: ${e.message}`));
  page.on("console", (m: any) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  return { page, errors };
}

describe.skipIf(!!reason)("live view", () => {
  test("keys line up with the timeline at every width", async () => {
    for (const width of [414, 768, 1024, 1600]) {
      const { page, errors } = await open({ width, height: 900 });
      const worst = await page.evaluate(() => {
        const container = document.getElementById("timelineContainer")!.getBoundingClientRect();
        const piano = document.getElementById("piano")!.getBoundingClientRect();
        let worstDelta = 0;
        for (let note = 21; note <= 108; note++) {
          const key = document.querySelector(`[data-note="${note}"]`)!.getBoundingClientRect();
          const keyCentre = key.left + key.width / 2 - piano.left;
          // @ts-expect-error - app.js global
          const spot = noteToX(note, container.width);
          worstDelta = Math.max(worstDelta, Math.abs(keyCentre - (spot.x + spot.w / 2)));
        }
        return { worstDelta, widthDelta: Math.abs(piano.width - container.width) };
      });
      expect(worst.widthDelta).toBeLessThan(1);
      expect(worst.worstDelta).toBeLessThan(1.5);
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 60_000);

  test("live mode never reads the database", async () => {
    const { page, errors } = await open();
    const calls: string[] = [];
    page.on("request", (r: any) => {
      if (r.url().includes("/api/")) calls.push(r.url());
    });

    // Fastest rate, so plenty of ticks happen in the window
    await page.selectOption("#timelineRate", "0.25");
    await page.fill("#timelineTempo", "200");
    await page.dispatchEvent("#timelineTempo", "input");
    await page.waitForTimeout(3000);

    expect(calls).toEqual([]);
    expect(await page.evaluate(() => isLive())).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("redraws at the chosen note length, and at 60Hz when asked", async () => {
    const { page, errors } = await open();
    await page.evaluate(() => {
      (window as any).__draws = 0;
      const ctx = (document.getElementById("timelineCanvas") as HTMLCanvasElement).getContext("2d")!;
      const clear = ctx.clearRect.bind(ctx);
      ctx.clearRect = (...args: any[]) => {
        (window as any).__draws++;
        return clear(...(args as [number, number, number, number]));
      };
    });

    const count = async (ms: number) => {
      await page.evaluate(() => ((window as any).__draws = 0));
      await page.waitForTimeout(ms);
      return page.evaluate(() => (window as any).__draws);
    };

    const quarterAt120 = await count(3000); // 500ms apart -> ~6
    expect(quarterAt120).toBeGreaterThanOrEqual(4);
    expect(quarterAt120).toBeLessThanOrEqual(9);

    await page.click("#timelineSmooth");
    await page.waitForTimeout(300);
    const smooth = await count(2000); // ~120
    expect(smooth).toBeGreaterThan(80);
    expect(await page.locator("#timelineRate").isDisabled()).toBe(true);

    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("flipping mirrors the time axis and survives a reload", async () => {
    const { page, errors } = await open();
    await page.evaluate(() => {
      timeline.startTime = Date.UTC(2026, 0, 15, 12);
      timeline.duration = 5 * 60 * 1000;
      drawTimeline();
    });

    const at = () => page.evaluate(() => Math.round(timeToY(timeline.startTime! + timeline.duration / 4)));
    const height = await page.evaluate(() => document.getElementById("timelineContainer")!.clientHeight);
    const down = await at();

    await page.click("#timelineFlip");
    await page.waitForTimeout(300);
    const up = await at();

    expect(down + up).toBeCloseTo(height, -1); // mirrored about the middle
    expect(await page.evaluate(() => Math.round(yToTime(timeToY(timeline.startTime!))))).toBe(
      await page.evaluate(() => timeline.startTime)
    );

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => timeline.flipped)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("the live toggle swaps the controls", async () => {
    const { page, errors } = await open();
    expect(await page.isVisible("#liveRateControls")).toBe(true);
    expect(await page.isVisible("#timelineNavControls")).toBe(false);

    await page.click("#btnLiveToggle");
    await page.waitForTimeout(300);
    expect(await page.isVisible("#liveRateControls")).toBe(false);
    expect(await page.isVisible("#timelineNavControls")).toBe(true);
    expect(await page.evaluate(() => isLive())).toBe(false);

    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe.skipIf(!!reason)("layout", () => {
  test("nothing is clipped at phone, tablet or desktop sizes", async () => {
    for (const vp of [
      { width: 414, height: 850 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1280, height: 900 },
    ]) {
      const { page, errors } = await open(vp);
      const fits = await page.evaluate(() => {
        const primary = document.querySelector(".primary")!.getBoundingClientRect();
        const card = document.querySelector(".timeline-card")!.getBoundingClientRect();
        const info = document.querySelector(".timeline-info")!.getBoundingClientRect();
        const controls = document.querySelector(".timeline-controls")!.getBoundingClientRect();
        return {
          cardFits: card.bottom <= primary.bottom + 1,
          infoVisible: info.bottom <= primary.bottom + 1 && info.height > 0,
          controlsVisible: controls.bottom <= primary.bottom + 1 && controls.height > 0,
          hScroll: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(fits).toEqual({ cardFits: true, infoVisible: true, controlsVisible: true, hScroll: false });
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 60_000);

  test("fullscreen hands the page to the timeline, and comes back", async () => {
    const { page, errors } = await open({ width: 1024, height: 768 });
    await page.click("#timelineFullscreen");
    await page.waitForTimeout(500);

    expect(await page.isVisible("header")).toBe(false);
    expect(await page.isVisible(".sidebar")).toBe(false);
    const filled = await page.evaluate(() => {
      const primary = document.querySelector(".primary")!.getBoundingClientRect();
      return primary.height / window.innerHeight;
    });
    expect(filled).toBeGreaterThan(0.9);

    await page.click("#timelineFullscreen");
    await page.waitForTimeout(400);
    expect(await page.isVisible("header")).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe.skipIf(!!reason)("history view", () => {
  test("loads days and segments for recorded activity", async () => {
    // Give the throwaway database something to find
    const base = Date.now() - 2 * 60 * 60 * 1000;
    for (let i = 0; i < 20; i++) {
      await fetch(`${URL}api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_time: base, end_time: base + 1000, song_name: `s${i}` }),
      });
    }

    const { page, errors } = await open();
    await page.click('#tabs .tab[data-view="history"]');
    await page.waitForTimeout(1500);
    expect(await page.isVisible("#viewHistory")).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe.skipIf(!!reason)("import/export view", () => {
  test("lists sessions with a MIDI export link", async () => {
    const base = Date.now() - 60 * 60 * 1000;
    await fetch(`${URL}api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_time: base, end_time: base + 1000, song_name: "Export me" }),
    });

    const { page, errors } = await open();
    await page.click('#tabs .tab[data-view="io"]');
    await page.waitForTimeout(500);
    expect(await page.isVisible("#viewIO")).toBe(true);
    const href = await page.getAttribute(".io-session .io-export", "href");
    expect(href).toMatch(/\/api\/sessions\/\d+\/export\.mid/);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("inline piano-roll preview renders the shared component (88 keys + sized canvas)", async () => {
    const { page, errors } = await open();
    await page.click('#tabs .tab[data-view="io"]');
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const t = Date.now();
      const events = [
        { type: "noteon", note: 60, velocity: 90, timestamp: t },
        { type: "noteon", note: 64, velocity: 90, timestamp: t + 5 },
        { type: "noteoff", note: 60, velocity: 0, timestamp: t + 500 },
        { type: "noteoff", note: 64, velocity: 0, timestamp: t + 500 },
      ];
      (window as any).openIOPianoRoll(events, { start: t - 50, end: t + 600, title: "Test" });
    });
    await page.waitForTimeout(400);
    expect(await page.isVisible("#ioPreview")).toBe(true);
    const info = await page.evaluate(() => {
      const c = document.querySelector("#ioPreviewBody canvas") as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      const keys = document.querySelectorAll("#ioPreviewBody .white-key, #ioPreviewBody .black-key").length;
      return { w: r.width, h: r.height, keys };
    });
    expect(info.w).toBeGreaterThan(50);
    expect(info.h).toBeGreaterThan(50);
    expect(info.keys).toBe(88);
    await page.click("#ioPreviewClose");
    await page.waitForTimeout(150);
    expect(await page.isVisible("#ioPreview")).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});
