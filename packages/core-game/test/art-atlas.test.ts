import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { ART_WALK_FRAMES, enemyFrameName, faceLeft, heroPose, orbiterArtScale, walkFrame } from "../src/game/render/art-atlas";

// Черновой арт забега за переключателем разработчика (design/art/README.md):
// рендер, на исход забега не влияет.

describe("кадр шага", () => {
  it("меняется раз в восемь тиков и идёт по кругу", () => {
    expect([0, 7, 8, 16, 24, 32].map((tick) => walkFrame(tick, 0))).toEqual([0, 0, 1, 2, 3, 0]);
  });

  it("соседние слоты не шагают в ногу", () => {
    const frames = new Set(Array.from({ length: 8 }, (_, slot) => walkFrame(0, slot)));
    expect(frames.size).toBeGreaterThan(1);
  });

  it("всегда в пределах кадров атласа", () => {
    for (let tick = 0; tick < 200; tick += 13) for (let slot = 0; slot < 50; slot += 7) {
      const frame = walkFrame(tick, slot);
      expect(frame).toBeGreaterThanOrEqual(0);
      expect(frame).toBeLessThan(ART_WALK_FRAMES);
    }
  });
});

describe("направление спрайта", () => {
  it("отражается по знаку скорости", () => {
    expect(faceLeft(-50, 60, false)).toBe(true);
    expect(faceLeft(50, 60, true)).toBe(false);
  });

  it("почти вертикальный ход не перещёлкивает отражение", () => {
    expect(faceLeft(-5, 60, false)).toBe(false);
    expect(faceLeft(5, 60, true)).toBe(true);
  });
});

describe("атлас покрывает контент", () => {
  // Новый враг без арта рисуется фигурой — это не ошибка, но черновик арта
  // обязан покрывать нынешний ростер, иначе сравнение в забеге неполное.
  const frames = new Set<string>();
  for (const pack of ["core", "late"]) {
    const atlas = JSON.parse(readFileSync(new URL(`../../../design/art/out/atlas-${pack}.json`, import.meta.url), "utf8")) as { frames: Record<string, unknown> };
    for (const name of Object.keys(atlas.frames)) frames.add(name);
  }

  it("у каждого врага есть кадры шага", () => {
    for (const enemy of ENEMIES) {
      for (let k = 0; k < ART_WALK_FRAMES; k++) expect(frames.has(enemyFrameName(enemy.id, 0, k)), enemy.id).toBe(true);
    }
  });

  it("у героя есть покой и шаг", () => {
    for (const name of ["hero/idle0", "hero/idle1", "hero/walk0", "hero/walk3"]) expect(frames.has(name), name).toBe(true);
  });
});

describe("оберег черновой арта", () => {
  it("свечение кадра совпадает с зоной удара оберега", () => {
    // Ячейка 16 единиц, свечение — 0,8 ячейки: диаметр 12,8 × масштаб = 2 × радиус удара.
    expect(16 * 0.8 * orbiterArtScale(16)).toBeCloseTo(32, 6);
  });
});

describe("поза героя-спрайта", () => {
  it("на попадании — кадр отдачи, и на бегу тоже", () => {
    expect(heroPose(false, true)).toBe("hurt");
    expect(heroPose(true, true)).toBe("hurt");
  });

  it("без попадания — шаг на ходу, дыхание на месте", () => {
    expect(heroPose(true, false)).toBe("walk");
    expect(heroPose(false, false)).toBe("idle");
  });

  it("кадр отдачи лежит в атласе core", () => {
    const atlas = JSON.parse(readFileSync(new URL("../../../design/art/out/atlas-core.json", import.meta.url), "utf8")) as { frames: Record<string, unknown> };
    expect(atlas.frames["hero/hurt0"]).toBeDefined();
  });
});
