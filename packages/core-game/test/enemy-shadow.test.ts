import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Тень врагов убрана на живом тесте (решение владельца от 13.10.2026);
// у героя, кристаллов и подборов она остаётся. Рендер без Phaser не создать,
// поэтому проверка идёт по исходнику.
const source = (name: string): string => readFileSync(new URL(`../src/game/render/${name}`, import.meta.url), "utf8");

/** Кусок исходника между двумя метками. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`В исходнике нет меток «${from}» и «${to}»`);
  return text.slice(start, end);
}

describe("тень в текстурах рендера", () => {
  const renderer = source("WorldRenderer.ts");

  it("у врагов тени нет", () => {
    const enemies = between(renderer, "world.enemyTypes.forEach", "this.textureKeyByType.push(key)");
    expect(enemies).toContain("ensureShapeTexture(");
    expect(enemies).not.toMatch(/shadow/i);
  });

  it("у героя тень осталась", () => {
    expect(between(renderer, 'ensureShapeTexture(scene, "bh-player"', "\n")).toMatch(/shadow:\s*true/);
  });

  it("у кристаллов и подборов тень осталась", () => {
    expect(source("pickups.ts")).toMatch(/shadow:\s*true/);
  });
});
