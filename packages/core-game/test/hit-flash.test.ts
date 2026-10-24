import { describe, expect, it } from "vitest";
import { ART_HIT_FLASH_GAP, ART_HIT_FLASH_TICKS, artFlashStart, NO_FLASH } from "../src/game/render/hit-flash";

/** Сколько тиков из `ticks` спрайт бел, если по нему бьют каждые `every` тиков. */
function whiteShare(every: number, ticks: number): number {
  let start = NO_FLASH;
  let hitTick = -1_000;
  let white = 0;
  for (let tick = 0; tick < ticks; tick++) {
    if (tick % every === 0) hitTick = tick;
    const next = artFlashStart(tick, hitTick, start);
    if (next !== null) {
      start = next;
      white++;
    }
  }
  return white / ticks;
}

describe("вспышка попадания у спрайта", () => {
  it("одиночный удар — вспышка на ART_HIT_FLASH_TICKS тиков", () => {
    let start = NO_FLASH;
    const lit: number[] = [];
    for (let tick = 100; tick < 120; tick++) {
      const next = artFlashStart(tick, 100, start);
      if (next !== null) {
        start = next;
        lit.push(tick);
      }
    }
    expect(lit).toEqual(Array.from({ length: ART_HIT_FLASH_TICKS }, (_, k) => 100 + k));
  });

  it("под ударом каждый тик спрайт бел не больше четверти времени", () => {
    const share = whiteShare(1, 600);
    expect(share).toBeLessThanOrEqual(0.25);
    expect(share).toBeCloseTo(ART_HIT_FLASH_TICKS / (ART_HIT_FLASH_TICKS + ART_HIT_FLASH_GAP), 2);
  });

  it("редкие удары вспыхивают каждый: пауза короче промежутка между ними", () => {
    const every = ART_HIT_FLASH_TICKS + ART_HIT_FLASH_GAP + 2;
    expect(whiteShare(every, every * 20)).toBeCloseTo(ART_HIT_FLASH_TICKS / every, 2);
  });

  it("удар в паузе вспышку не зажигает, после паузы — зажигает", () => {
    expect(artFlashStart(105, 105, 100)).toBeNull();
    expect(artFlashStart(100 + ART_HIT_FLASH_TICKS + ART_HIT_FLASH_GAP, 100 + ART_HIT_FLASH_TICKS + ART_HIT_FLASH_GAP, 100)).toBe(100 + ART_HIT_FLASH_TICKS + ART_HIT_FLASH_GAP);
  });
});
