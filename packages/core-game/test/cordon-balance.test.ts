import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";

// Строй не должен стать тесным и коротким: он встаёт дальше зоны «Очага» (до 140),
// иначе зона достаёт стражей сразу, а сжатие занимает около минуты на любом радиусе.
const MIN_RING_RADIUS = 255;
const MIN_RING_INNER_RADIUS = 120;
const MIN_SHRINK_PATH_SEC = 50;

const cordonEventAt = (fromSec: number) =>
  TIMELINE.find((segment) => segment.fromSec === fromSec)?.events?.find((event) => event.kind === "cordon");
const curveCordon = ENDLESS_CURVE.events.find((event) => event.kind === "cordon");

describe("числа кольца стражей (Р166)", () => {
  it("страж падает от стартового оружия в одиночку за 25–30 с: проход открывают несколько оружий разом", () => {
    // Стартовое оружие по умолчанию — первое не эволюционное (findStartingWeapon).
    const weapon = WEAPONS.find((candidate) => candidate.evolvedFrom === undefined);
    const level = weapon?.levels[0];
    const guard = ENEMIES.find((enemy) => enemy.id === "cordon_guard");
    expect(weapon, "стартовое оружие").toBeDefined();
    expect(level?.damage).toBeDefined();
    expect(level?.cooldownSec).toBeDefined();
    expect(guard).toBeDefined();
    const dps = (level?.damage ?? 0) / (level?.cooldownSec ?? 1);
    const seconds = (guard?.hp ?? 0) / dps;
    expect(seconds, `оружие ${weapon?.id}`).toBeGreaterThanOrEqual(25);
    expect(seconds, `оружие ${weapon?.id}`).toBeLessThanOrEqual(30);
  });

  it("строй встаёт широко: радиус не меньше 255, предел сжатия не меньше 120", () => {
    for (const [where, ring] of [
      ["180 с", cordonEventAt(180)?.ring],
      ["300 с", cordonEventAt(300)?.ring],
      ["кривая", curveCordon?.ring],
    ] as const) {
      expect(ring?.radius, `радиус кольца ${where}`).toBeGreaterThanOrEqual(MIN_RING_RADIUS);
      expect(ring?.minRadius, `minRadius кольца ${where}`).toBeGreaterThanOrEqual(MIN_RING_INNER_RADIUS);
    }
  });

  it("сжатие медленное: путь от radius до minRadius занимает не меньше 50 с, как бы широко ни встал строй", () => {
    for (const [where, ring] of [
      ["180 с", cordonEventAt(180)?.ring],
      ["300 с", cordonEventAt(300)?.ring],
      ["кривая", curveCordon?.ring],
    ] as const) {
      expect(ring, `кольцо ${where}`).toBeDefined();
      const pathSec = ((ring?.radius ?? 0) - (ring?.minRadius ?? 0)) / (ring?.shrinkPerSec ?? 1);
      expect(pathSec, `путь сжатия кольца ${where}`).toBeGreaterThanOrEqual(MIN_SHRINK_PATH_SEC);
    }
  });

  it("элита внутри строя — только у колец кривой, ручные кольца без неё; боссов внутри нет нигде", () => {
    const rings = [
      { where: "180 с", ring: cordonEventAt(180)?.ring, eliteInside: false },
      { where: "300 с", ring: cordonEventAt(300)?.ring, eliteInside: false },
      { where: "кривая", ring: curveCordon?.ring, eliteInside: true },
    ];
    for (const { where, ring, eliteInside } of rings) {
      const ranks = (ring?.inner ?? []).map((entry) => ENEMIES.find((enemy) => enemy.id === entry.enemy)?.rank);
      expect(ranks.includes("elite"), `элита в кольце ${where}`).toBe(eliteInside);
      expect(ranks.includes("boss"), `босс в кольце ${where}`).toBe(false);
    }
  });

  it("первую элиту на 300 с приводит обычное событие ring, как до задачи", () => {
    const events = TIMELINE.find((segment) => segment.fromSec === 300)?.events ?? [];
    const eliteRings = events.filter(
      (event) => event.kind === "ring" && ENEMIES.find((enemy) => enemy.id === event.enemy)?.rank === "elite",
    );
    expect(eliteRings).toHaveLength(1);
  });
});
