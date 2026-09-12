import type { MapDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { MAPS } from "../src/content/maps";
import { WEAPONS } from "../src/content/weapons";
import { RunCamera } from "../src/game/render/run-camera";
import { spawnGem } from "../src/game/sim/gems";
import {
  findMapContentProblems,
  maxVisibleHalfDiagonalUnits,
  spawnRadiusUnits,
} from "../src/game/sim/map-types";
import { spawnRandomOnRing } from "../src/game/sim/spawner";
import { stepWorld } from "../src/game/sim/step";
import { createWorld, spawnEnemy, spawnProjectile, type World } from "../src/game/sim/world";

// Бесконечный мир, границы карты и камера (docs/26-stage2-plan.md, WP4.1–WP4.3).

const OPEN_MAP = MAPS[0];

/** Карта с границами по обеим осям — та самая «особенность карты» из Р3. */
const WALLED_MAP: MapDef = {
  ...OPEN_MAP,
  id: "walled",
  bounds: { halfWidth: 700, halfHeight: 700 },
};

function makeWorld(map: MapDef = OPEN_MAP, overrides = {}): World {
  return createWorld({
    seed: 1,
    enemies: ENEMIES,
    weapons: WEAPONS,
    map,
    config: { progressionEnabled: false, ...overrides },
  });
}

describe("бесконечный мир", () => {
  it("хранит позиции с двойной точностью — иначе далёкий забег начинает залипать", () => {
    const world = makeWorld();
    expect(world.enemies.x).toBeInstanceOf(Float64Array);
    expect(world.projectiles.x).toBeInstanceOf(Float64Array);
    expect(world.gems.x).toBeInstanceOf(Float64Array);
  });

  it("не держит игрока в границах, когда их нет", () => {
    const world = makeWorld();
    for (let i = 0; i < 60 * 120; i++) stepWorld(world, { moveX: 1, moveY: 0 });

    expect(world.player.x).toBeGreaterThan(20_000);
    expect(Number.isFinite(world.player.x)).toBe(true);
  });

  it("остаётся точным далеко от начала координат", () => {
    const world = makeWorld();
    world.player.x = 250_000;
    world.player.y = -180_000;
    const before = world.player.x;

    stepWorld(world, { moveX: 1, moveY: 0 });
    // На Float32 шаг в сотые доли единицы здесь просто потерялся бы: у числа
    // порядка 250 000 соседнее представимое отстоит примерно на 0.015.
    expect(world.player.x).toBeGreaterThan(before);
  });

  it("уносит отставших врагов вперёд, а не бросает их за спиной", () => {
    // Без оружия: подопытный обязан отстать, а не погибнуть по дороге —
    // мёртвый враг не проверяет ничего.
    const world = createWorld({
      seed: 1,
      enemies: ENEMIES,
      map: OPEN_MAP,
      config: { progressionEnabled: false },
    });
    const slot = spawnEnemy(world, 0, -400, 0);
    expect(slot).toBeGreaterThanOrEqual(0);

    // Игрок убегает от медленного врага — тот неизбежно отстаёт.
    let seen = 0;
    let aheadBy = 0;
    let distanceAtMove = 0;

    for (let i = 0; i < 60 * 30; i++) {
      stepWorld(world, { moveX: 1, moveY: 0 });
      if (world.stats.enemiesRecycled === seen) continue;

      seen = world.stats.enemiesRecycled;
      aheadBy = world.enemies.x[slot] - world.player.x;
      distanceAtMove = Math.hypot(
        world.enemies.x[slot] - world.player.x,
        world.enemies.y[slot] - world.player.y,
      );
    }

    expect(seen).toBeGreaterThan(0);
    // Перенесён именно вперёд: игрок бежит вправо, враг появляется справа.
    expect(aheadBy).toBeGreaterThan(0);
    // И ровно на кольце спавна — то есть за краем видимости, а не на экране.
    expect(distanceAtMove).toBeGreaterThanOrEqual(world.config.view.spawnRadius - 5);
    expect(distanceAtMove).toBeLessThanOrEqual(world.config.view.retentionRadius);
  });

  it("не тащит за игроком снаряды и кристаллы, оставшиеся далеко позади", () => {
    const world = makeWorld(OPEN_MAP, { progressionEnabled: true });
    spawnProjectile(world, 0, 0, 0, 0, 5, 999, true);
    spawnGem(world, 0, 0, 3);
    expect(world.projectiles.aliveCount).toBe(1);
    expect(world.gems.aliveCount).toBe(1);

    for (let i = 0; i < 60 * 20; i++) stepWorld(world, { moveX: 1, moveY: 0 });

    expect(world.projectiles.aliveCount).toBe(0);
    expect(world.gems.aliveCount).toBe(0);
  });
});

describe("границы карты", () => {
  it("держит игрока внутри и гасит скорость у стены", () => {
    const world = makeWorld(WALLED_MAP);
    for (let i = 0; i < 60 * 60; i++) stepWorld(world, { moveX: -1, moveY: 0 });

    const limit = WALLED_MAP.bounds!.halfWidth! - world.config.player.radius;
    expect(world.player.x).toBeCloseTo(-limit, 3);
    expect(world.player.vx).toBe(0);
  });

  it("не выпускает врагов за стену", () => {
    const world = makeWorld(WALLED_MAP);
    const limit = WALLED_MAP.bounds!.halfWidth!;

    for (let i = 0; i < 200; i++) spawnRandomOnRing(world, i % world.enemyTypes.length);
    for (let i = 0; i < 60 * 30; i++) stepWorld(world, { moveX: 1, moveY: 1 });

    for (let i = 0; i < world.enemies.count; i++) {
      if (world.enemies.alive[i] === 0) continue;
      expect(Math.abs(world.enemies.x[i])).toBeLessThanOrEqual(limit);
      expect(Math.abs(world.enemies.y[i])).toBeLessThanOrEqual(limit);
    }
  });

  it("никогда не ставит врага за границей и никогда — в видимой области", () => {
    // Тысячи проверок на разных позициях игрока: спавн у стены — это тот
    // случай, где кольцо обязано выбрать допустимую дугу, а не «примерно».
    const world = makeWorld(WALLED_MAP);
    const limit = WALLED_MAP.bounds!.halfWidth!;
    const hidden = maxVisibleHalfDiagonalUnits(WALLED_MAP.camera);
    let checked = 0;

    for (let step = 0; step < 2000; step++) {
      world.player.x = ((step * 137) % (limit * 2)) - limit;
      world.player.y = ((step * 251) % (limit * 2)) - limit;

      const slot = spawnRandomOnRing(world, step % world.enemyTypes.length);
      if (slot < 0) break;

      const distance = Math.hypot(
        world.enemies.x[slot] - world.player.x,
        world.enemies.y[slot] - world.player.y,
      );
      expect(distance).toBeGreaterThanOrEqual(hidden);
      expect(Math.abs(world.enemies.x[slot])).toBeLessThanOrEqual(limit);
      expect(Math.abs(world.enemies.y[slot])).toBeLessThanOrEqual(limit);

      world.enemies.alive[slot] = 0;
      world.enemies.aliveCount--;
      checked++;
    }

    expect(checked).toBeGreaterThan(1500);
  });

  it("не даёт задать карту уже кольца спавна", () => {
    const tiny: MapDef = { ...OPEN_MAP, id: "tiny", bounds: { halfWidth: 100 } };
    expect(findMapContentProblems([tiny]).join("\n")).toMatch(/halfWidth/);
  });
});

describe("динамическая камера", () => {
  /** Сколько мира видно в игровых единицах при таком масштабе и канве. */
  function visibleArea(camera: RunCamera, width: number, height: number, unitScale: number): number {
    return (width * height) / (camera.zoom * camera.zoom * unitScale * unitScale);
  }

  it("показывает одинаковый объём мира в портрете и в ландшафте", () => {
    // Решение Р14: иначе телефон, повёрнутый набок, получает преимущество.
    const world = makeWorld();
    const portrait = new RunCamera(OPEN_MAP.camera, 1);
    const landscape = new RunCamera(OPEN_MAP.camera, 1);

    portrait.snapTo(world, 390, 844);
    landscape.snapTo(world, 844, 390);

    expect(visibleArea(portrait, 390, 844, 1)).toBeCloseTo(OPEN_MAP.camera.viewAreaMoving, 0);
    expect(visibleArea(landscape, 844, 390, 1)).toBeCloseTo(OPEN_MAP.camera.viewAreaMoving, 0);
  });

  it("не даёт вытянутому экрану смотреть дальше предела", () => {
    const world = makeWorld();
    const ultrawide = new RunCamera(OPEN_MAP.camera, 1);
    ultrawide.snapTo(world, 2400, 600);

    const seen = visibleArea(ultrawide, 2400, 600, 1);
    expect(seen).toBeLessThan(OPEN_MAP.camera.viewAreaMoving);
    // И главное: по длинной стороне видно не больше, чем на крайнем допустимом
    // соотношении сторон, от которого считается кольцо спавна.
    const longSideUnits = 2400 / ultrawide.zoom;
    expect(longSideUnits).toBeLessThanOrEqual(
      Math.sqrt(OPEN_MAP.camera.viewAreaMoving * OPEN_MAP.camera.maxAspect) + 1e-6,
    );
  });

  it("не зависит от плотности экрана: объём мира на телефоне тот же", () => {
    const world = makeWorld(OPEN_MAP, { unitScale: 3 });
    const dense = new RunCamera(OPEN_MAP.camera, 3);
    dense.snapTo(world, 390 * 3, 844 * 3);

    expect(visibleArea(dense, 390 * 3, 844 * 3, 3)).toBeCloseTo(
      OPEN_MAP.camera.viewAreaMoving,
      0,
    );
  });

  it("приближается только после задержки, а отдаляется сразу", () => {
    const world = makeWorld();
    const camera = new RunCamera(OPEN_MAP.camera, 1);
    camera.snapTo(world, 390, 844);
    const far = camera.zoom;

    // Игрок стоит: пока не вышла задержка, масштаб не меняется.
    for (let i = 0; i < 10; i++) camera.update(world, 1 / 60);
    expect(camera.zoom).toBeCloseTo(far, 6);

    for (let i = 0; i < 60 * 5; i++) camera.update(world, 1 / 60);
    const near = camera.zoom;
    expect(near).toBeGreaterThan(far);

    // Пошёл — отдаление начинается с первого же кадра.
    world.player.vx = world.config.player.speedPxSec;
    camera.update(world, 1 / 60);
    expect(camera.zoom).toBeLessThan(near);
  });

  it("радиус кольца спавна считается от карты, а не от устройства", () => {
    const phone = makeWorld(OPEN_MAP, { unitScale: 3 });
    const desktop = makeWorld(OPEN_MAP, { unitScale: 1 });

    expect(desktop.config.view.spawnRadius).toBeCloseTo(spawnRadiusUnits(OPEN_MAP.camera), 6);
    expect(phone.config.view.spawnRadius).toBeCloseTo(desktop.config.view.spawnRadius * 3, 6);
  });
});
