import { describe, expect, it } from "vitest";
import { bestWeapon, deathStep, levelBar } from "../src/screens/run/death-rules";
import { visibleWays } from "../src/screens/run/SecondChance";

// Правила экрана смерти в два шага (design/screens/death.html): какой шаг
// показать, какая полоса уровня и какое оружие лучшее, какие способы второго
// шанса видны.

const OFFER = { continueNo: 1, priceStars: 7, chargedStars: 7, mode: "live" } as const;

describe("шаг экрана смерти", () => {
  it("пока забег ждёт решения и есть способы — шаг со вторым шансом", () => {
    expect(deathStep({ phase: "downed", hasWays: true })).toBe("chance");
  });

  it("ждёт решения, но продолжить нечем — сразу итоги", () => {
    expect(deathStep({ phase: "downed", hasWays: false })).toBe("results");
  });

  it("забег закрыт — итоги, со способами или без", () => {
    expect(deathStep({ phase: "finished", hasWays: true })).toBe("results");
    expect(deathStep({ phase: "finished", hasWays: false })).toBe("results");
  });
});

describe("полоса уровня после забега", () => {
  const progress = (xpIntoLevel: number, xpForNext: number | null, level = 6) => ({ level, xpIntoLevel, xpForNext });

  it("без роста уровня: что было до забега и что стало", () => {
    expect(levelBar({ xp: 100, levelBefore: 6, levelAfter: 6, progress: progress(300, 500) })).toEqual({ level: 6, before: 0.4, after: 0.6, toNext: 200 });
  });

  it("с ростом уровня сплошной части нет: забег начал уровень с нуля", () => {
    expect(levelBar({ xp: 420, levelBefore: 3, levelAfter: 4, progress: progress(100, 400, 4) })).toEqual({ level: 4, before: 0, after: 0.25, toNext: 300 });
  });

  it("наивысший уровень — полная полоса и нет «до следующего»", () => {
    expect(levelBar({ xp: 50, levelBefore: 30, levelAfter: 30, progress: progress(0, null, 30) })).toEqual({ level: 30, before: 1, after: 1, toNext: null });
  });

  it("опыта больше, чем набрано на уровне, без роста уровня (рассинхрон) — до забега не меньше нуля", () => {
    const bar = levelBar({ xp: 900, levelBefore: 6, levelAfter: 6, progress: progress(300, 500) });
    expect(bar.before).toBe(0);
    expect(bar.after).toBe(0.6);
  });

  it("доли зажаты в 0..1", () => {
    const bar = levelBar({ xp: 10, levelBefore: 6, levelAfter: 6, progress: progress(900, 500) });
    expect(bar.before).toBeLessThanOrEqual(1);
    expect(bar.after).toBe(1);
  });
});

describe("лучшее оружие", () => {
  it("с наибольшим уроном", () => {
    expect(
      bestWeapon([
        { id: "spark", damage: 9310 },
        { id: "wardstone", damage: 18420 },
        { id: "knife", damage: 2240 },
      ]),
    ).toBe("wardstone");
  });

  it("оружия нет — `null`", () => {
    expect(bestWeapon([])).toBeNull();
  });

  it("равный урон — первое по порядку", () => {
    expect(
      bestWeapon([
        { id: "knife", damage: 100 },
        { id: "spark", damage: 100 },
      ]),
    ).toBe("knife");
  });
});

describe("какие способы второго шанса видны", () => {
  it("VIP — одна кнопка: ни ролика, ни звёзд", () => {
    expect(visibleWays({ adStage: { kind: "ready", pass: true, notice: null }, paidStage: { kind: "ready", offer: OFFER } })).toEqual({ ad: false, stars: false, vip: true });
    expect(visibleWays({ adStage: { kind: "watching", pass: true }, paidStage: { kind: "ready", offer: OFFER } })).toEqual({ ad: false, stars: false, vip: true });
  });

  it("ролик недоступен — только звёзды", () => {
    expect(visibleWays({ adStage: { kind: "unavailable", reason: "no_fill" }, paidStage: { kind: "ready", offer: OFFER } })).toEqual({ ad: false, stars: true, vip: false });
  });

  it("звёзды недоступны, а ролик есть — только ролик", () => {
    expect(visibleWays({ adStage: { kind: "ready", pass: false, notice: null }, paidStage: { kind: "unavailable", reason: "used_up" } })).toEqual({ ad: true, stars: false, vip: false });
  });

  it("оба способа есть — видны оба", () => {
    expect(visibleWays({ adStage: { kind: "ready", pass: false, notice: null }, paidStage: { kind: "ready", offer: OFFER } })).toEqual({ ad: true, stars: true, vip: false });
  });

  it("оба недоступны — блок звёзд остаётся и сам объясняет, почему купить нельзя (правило прежнее)", () => {
    expect(visibleWays({ adStage: { kind: "unavailable", reason: "no_fill" }, paidStage: { kind: "unavailable", reason: "not_offered" } })).toEqual({ ad: false, stars: true, vip: false });
  });

  it("способов не заведено вовсе — ничего", () => {
    expect(visibleWays({ adStage: null, paidStage: null })).toEqual({ ad: false, stars: false, vip: false });
  });
});
