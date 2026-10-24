import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPIN_DURATION_MS, SPIN_EASE, spinRotationDeg, spinTicks, TICK_MIN_GAP_MS, TICK_SLOW_GAP_MS } from "../src/screens/meta/wheel-math";

// Трещотка колеса (design/art/direction-v2.md §7.6): щелчок на каждый сектор
// под стрелкой, в такт замедлению колеса на экране.

const tokens = readFileSync(fileURLToPath(new URL("../src/design-system/tokens.css", import.meta.url)), "utf8");

describe("щелчки колеса", () => {
  const to = spinRotationDeg(0, 3, 8, 5);
  const ticks = spinTicks(0, to, 8);

  it("длительность и кривая — те же, что у крутки в CSS: звук и колесо идут в такт", () => {
    expect(tokens).toContain(`--duration-spin: ${String(SPIN_DURATION_MS)}ms;`);
    expect(tokens).toContain(`--ease-spin: cubic-bezier(${SPIN_EASE.join(", ")});`);
  });

  it("все щелчки — внутри крутки, по порядку и не чаще порога", () => {
    expect(ticks.length).toBeGreaterThan(10);
    let last = -Infinity;
    for (const tick of ticks) {
      expect(tick.atMs).toBeGreaterThan(0);
      expect(tick.atMs).toBeLessThanOrEqual(SPIN_DURATION_MS);
      expect(tick.atMs - last).toBeGreaterThanOrEqual(TICK_MIN_GAP_MS);
      last = tick.atMs;
    }
  });

  it("щелчков не больше, чем секторов прошло под стрелкой", () => {
    expect(ticks.length).toBeLessThanOrEqual(Math.floor(to / (360 / 8)));
  });

  it("к концу щелчки редеют, и последние — медленные, с вибрацией", () => {
    const gaps = ticks.slice(1).map((tick, i) => tick.atMs - (ticks[i]?.atMs ?? 0));
    expect(gaps.at(-1) ?? 0).toBeGreaterThan(gaps[0] ?? Infinity);
    expect(ticks.at(-1)?.slow).toBe(true);
    expect(ticks[0]?.slow).toBe(false);
    for (const [i, tick] of ticks.entries()) {
      if (i === 0) continue;
      expect(tick.slow).toBe(tick.atMs - (ticks[i - 1]?.atMs ?? 0) >= TICK_SLOW_GAP_MS);
    }
  });

  it("без поворота или без секторов щелчков нет", () => {
    expect(spinTicks(90, 90, 8)).toEqual([]);
    expect(spinTicks(0, 720, 0)).toEqual([]);
  });
});
