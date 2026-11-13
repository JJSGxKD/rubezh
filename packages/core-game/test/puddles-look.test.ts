import { describe, expect, it } from "vitest";
import { PUDDLE_FADE_TICKS, puddleAlpha, puddleArtFrame, puddleTone } from "../src/game/render/puddles";
import { STATUS_TONE, STATUS_TONE_COLORS } from "../src/game/render/status-tones";

/**
 * Облик луж врага со следом (T-0282): тон стихии, затухание в последние 0,8 с
 * жизни и кадр арта по возрасту. Сами спрайты красит рендер — здесь правила.
 */

const LIFE = 240;

describe("облик луж", () => {
  it("красится тоном стихии врага; без стихии — нейтральным, не тоном состояния", () => {
    expect(puddleTone("poison")).toBe(STATUS_TONE_COLORS[STATUS_TONE.poison]);
    expect(puddleTone("fire")).toBe(STATUS_TONE_COLORS[STATUS_TONE.burn]);
    expect(puddleTone("cold")).toBe(STATUS_TONE_COLORS[STATUS_TONE.chill]);
    expect(puddleTone("lightning")).toBe(STATUS_TONE_COLORS[STATUS_TONE.shock]);
    expect(STATUS_TONE_COLORS).not.toContain(puddleTone(undefined));
  });

  it("гаснет в последние 0,8 с жизни и не раньше", () => {
    expect(PUDDLE_FADE_TICKS).toBe(48);
    expect(puddleAlpha(LIFE)).toBe(1);
    expect(puddleAlpha(PUDDLE_FADE_TICKS)).toBe(1);
    expect(puddleAlpha(PUDDLE_FADE_TICKS / 2)).toBeCloseTo(0.5, 5);
    expect(puddleAlpha(0)).toBe(0);
  });

  it("кадр арта: свежая, подсохшая, гаснущая", () => {
    expect(puddleArtFrame(LIFE, LIFE)).toBe(0);
    expect(puddleArtFrame(LIFE / 2 + 1, LIFE)).toBe(0);
    expect(puddleArtFrame(LIFE / 2, LIFE)).toBe(1);
    expect(puddleArtFrame(PUDDLE_FADE_TICKS + 1, LIFE)).toBe(1);
    expect(puddleArtFrame(PUDDLE_FADE_TICKS, LIFE)).toBe(2);
    expect(puddleArtFrame(1, LIFE)).toBe(2);
  });

  it("у короткой лужи гаснущий кадр не вытесняет свежий целиком", () => {
    expect(puddleArtFrame(60, 60)).toBe(0);
    expect(puddleArtFrame(PUDDLE_FADE_TICKS, 60)).toBe(2);
  });
});
