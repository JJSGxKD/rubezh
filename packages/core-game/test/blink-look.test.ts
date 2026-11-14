import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { BLINK_APPEAR_SEC, BLINK_FADE_SEC, BLINK_PHASE } from "../src/game/patterns";
import { blinkAlpha, blinkMarkFrame, blinkMarkFrameNames, blinkMarkProgress, blinkMarkRadius } from "../src/game/render/blink-look";
import { ENEMY_LOOKS, enemyColor } from "../src/game/render/looks";

// Облик Кикиморы (T-0283): тает к нулю, пока скрыта — прозрачна, на появлении проявляется; метка на земле
// сужается к концу telegraphSec.

describe("прозрачность Кикиморы", () => {
  it("в chase непрозрачна", () => {
    expect(blinkAlpha(BLINK_PHASE.chase, 0)).toBe(1);
    expect(blinkAlpha(BLINK_PHASE.chase, 3.7)).toBe(1);
  });

  it("в fading тает к нулю: от единицы к нулю по остатку таймера", () => {
    expect(blinkAlpha(BLINK_PHASE.fading, BLINK_FADE_SEC)).toBe(1);
    expect(blinkAlpha(BLINK_PHASE.fading, BLINK_FADE_SEC / 2)).toBeCloseTo(0.5, 6);
    expect(blinkAlpha(BLINK_PHASE.fading, 0)).toBe(0);
  });

  it("в hidden её нет, а на появлении она проявляется от нуля к единице", () => {
    expect(blinkAlpha(BLINK_PHASE.hidden, 0.4)).toBe(0);
    expect(blinkAlpha(BLINK_PHASE.appear, BLINK_APPEAR_SEC)).toBe(0);
    expect(blinkAlpha(BLINK_PHASE.appear, BLINK_APPEAR_SEC / 2)).toBeCloseTo(0.5, 6);
    expect(blinkAlpha(BLINK_PHASE.appear, 0)).toBe(1);
  });

  it("не выходит за 0…1, даже если таймер вышел из своих границ", () => {
    expect(blinkAlpha(BLINK_PHASE.fading, 5)).toBe(1);
    expect(blinkAlpha(BLINK_PHASE.fading, -1)).toBe(0);
    expect(blinkAlpha(BLINK_PHASE.appear, -1)).toBe(1);
  });
});

describe("метка появления", () => {
  it("прогресс — доля прошедшего telegraphSec: от нуля к единице", () => {
    expect(blinkMarkProgress(0.6, 0.6)).toBe(0);
    expect(blinkMarkProgress(0.3, 0.6)).toBeCloseTo(0.5, 6);
    expect(blinkMarkProgress(0, 0.6)).toBe(1);
    expect(blinkMarkProgress(-0.1, 0.6)).toBe(1);
    expect(blinkMarkProgress(2, 0.6)).toBe(0);
  });

  it("кольцо сужается: к концу меньше, чем в начале, и никогда не меньше тела", () => {
    const body = 11;
    const start = blinkMarkRadius(body, 0);
    const end = blinkMarkRadius(body, 1);
    expect(start).toBeGreaterThan(end);
    expect(end).toBeGreaterThanOrEqual(body);
    expect(blinkMarkRadius(body, 0.5)).toBeLessThan(start);
    expect(blinkMarkRadius(body, 0.5)).toBeGreaterThan(end);
  });

  it("кадры арта сменяются по прогрессу: три кадра, от широкого к узкому", () => {
    expect(blinkMarkFrame(0)).toBe(0);
    expect(blinkMarkFrame(0.32)).toBe(0);
    expect(blinkMarkFrame(0.5)).toBe(1);
    expect(blinkMarkFrame(0.7)).toBe(2);
    expect(blinkMarkFrame(1)).toBe(2);
  });

  it("имена кадров метки — по id врага: fx/mark_<id>0…2", () => {
    expect(blinkMarkFrameNames("kikimora")).toEqual(["fx/mark_kikimora0", "fx/mark_kikimora1", "fx/mark_kikimora2"]);
  });
});

describe("фигура Кикиморы", () => {
  it("своя форма у паттерна, не повторяющая прочие", () => {
    expect(ENEMY_LOOKS.blink.shape).toBe("lozenge");
    const others = Object.entries(ENEMY_LOOKS).filter(([pattern]) => pattern !== "blink");
    expect(others.some(([, look]) => look.shape === "lozenge")).toBe(false);
  });

  it("тело болотной зелени по id: зелёное, а не красное", () => {
    const color = enemyColor("blink", undefined, "kikimora");
    const green = (color >> 8) & 0xff;
    const red = (color >> 16) & 0xff;
    expect(green).toBeGreaterThan(red);
    expect(ENEMIES.some((enemy) => enemy.id === "kikimora")).toBe(true);
  });
});
