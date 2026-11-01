import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";

// Числа колец до Р166 (tasks/T-0342): сжатие обязано стать вдвое медленнее.
const SHRINK_BEFORE_R166 = { 180: 3, 300: 4, curve: 5 } as const;

const cordonEventAt = (fromSec: number) =>
  TIMELINE.find((segment) => segment.fromSec === fromSec)?.events?.find((event) => event.kind === "cordon");
const curveCordon = ENDLESS_CURVE.events.find((event) => event.kind === "cordon");

describe("числа кольца стражей (Р166)", () => {
  it("страж падает от стартового оружия за 10–15 с", () => {
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
    expect(seconds, `оружие ${weapon?.id}`).toBeGreaterThanOrEqual(10);
    expect(seconds, `оружие ${weapon?.id}`).toBeLessThanOrEqual(15);
  });

  it("сжатие вдвое медленнее прежнего", () => {
    expect(cordonEventAt(180)?.ring?.shrinkPerSec).toBeLessThanOrEqual(SHRINK_BEFORE_R166[180] / 2);
    expect(cordonEventAt(300)?.ring?.shrinkPerSec).toBeLessThanOrEqual(SHRINK_BEFORE_R166[300] / 2);
    expect(curveCordon?.ring?.shrinkPerSec).toBeLessThanOrEqual(SHRINK_BEFORE_R166.curve / 2);
  });

  it("внутри каждого кольца есть элита; босс только в кольце кривой и с fromSec не меньше 630", () => {
    const rings = [
      { where: "180 с", ring: cordonEventAt(180)?.ring, bossAllowed: false },
      { where: "300 с", ring: cordonEventAt(300)?.ring, bossAllowed: false },
      { where: "кривая", ring: curveCordon?.ring, bossAllowed: true },
    ];
    for (const { where, ring, bossAllowed } of rings) {
      const inner = ring?.inner ?? [];
      const ranks = inner.map((entry) => ({ entry, rank: ENEMIES.find((enemy) => enemy.id === entry.enemy)?.rank }));
      expect(ranks.some((item) => item.rank === "elite"), `элита в кольце ${where}`).toBe(true);
      for (const { entry, rank } of ranks) {
        if (rank !== "boss") continue;
        expect(bossAllowed, `босс в кольце ${where}`).toBe(true);
        expect(entry.fromSec ?? 0, `fromSec босса в кольце ${where}`).toBeGreaterThanOrEqual(630);
      }
    }
  });

  it("кольцо на 300 с не сопровождается отдельным событием ring элиты", () => {
    const events = TIMELINE.find((segment) => segment.fromSec === 300)?.events ?? [];
    const eliteRings = events.filter(
      (event) => event.kind === "ring" && ENEMIES.find((enemy) => enemy.id === event.enemy)?.rank === "elite",
    );
    expect(eliteRings).toEqual([]);
  });
});
