import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { ART_MOVING_EPSILON, ART_WALK_FRAMES, enemyFrameName, faceLeft, frameForEnemy, heroPose, isMoving, orbiterArtScale, walkFrame } from "../src/game/render/art-atlas";

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

describe("кадр шага врага по движению", () => {
  it("движется — листает, как раньше, последний кадр не влияет", () => {
    expect([0, 8, 16, 24, 32].map((tick) => frameForEnemy(tick, 0, true, 3))).toEqual([0, 1, 2, 3, 0]);
  });

  it("стоит — держит последний кадр, время не важно", () => {
    for (const tick of [100, 101, 130, 999]) expect(frameForEnemy(tick, 5, false, 2)).toBe(2);
  });

  it("появился стоя — кадр нулевой", () => {
    expect(frameForEnemy(57, 3, false, -1)).toBe(0);
  });

  it("замерший держит кадр, на котором остановился, а после разморозки идёт снова", () => {
    let last = -1;
    const frames: number[] = [];
    for (let step = 0; step < 16; step++) {
      last = frameForEnemy(step * 4, 2, step < 8, last);
      frames.push(last);
    }
    const stopped = frames.slice(8);
    expect(new Set(stopped)).toEqual(new Set([frames[7]]));
    expect(frameForEnemy(200, 2, true, last)).toBe(walkFrame(200, 2));
  });

  it("всегда в пределах кадров атласа", () => {
    for (let tick = 0; tick < 100; tick += 9) for (let slot = 0; slot < 20; slot += 3) for (const moving of [true, false]) for (let last = -1; last < ART_WALK_FRAMES; last++) {
      const frame = frameForEnemy(tick, slot, moving, last);
      expect(frame).toBeGreaterThanOrEqual(0);
      expect(frame).toBeLessThan(ART_WALK_FRAMES);
    }
  });

  it("порог движения строгий, по сумме модулей скоростей", () => {
    expect(isMoving(0, 0)).toBe(false);
    expect(isMoving(ART_MOVING_EPSILON, 0)).toBe(false);
    expect(isMoving(0.002, 0)).toBe(true);
    expect(isMoving(-0.002, 0.0001)).toBe(true);
    expect(isMoving(0.0004, -0.0004)).toBe(false);
  });

  it("рендер передаёт скорость врага и освобождает слот погибшего", () => {
    const source = readFileSync(new URL("../src/game/render/WorldRenderer.ts", import.meta.url), "utf8");
    expect(source).toContain("applyEnemy(sprite, i, texture, tick, enemies.vx[i], enemies.vy[i])");
    expect(source).toContain("releaseEnemy(i)");
  });
});
