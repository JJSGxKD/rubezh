import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { WEAPONS } from "../src/content/weapons";
import { createWorld, TICK_SEC } from "../src/game/sim/world";
import { stepWorld, IDLE_INPUT } from "../src/game/sim/step";
import { createConstantPopulationSpawner, createRampSpawner, rampTargetAt } from "../src/game/sim/spawner";

function world(overrides = {}) {
  return createWorld({
    seed: 1,
    enemies: ENEMIES,
    weapons: WEAPONS,
    // Прокачка выключена: эти тесты про движение, спавн и коллизии, а
    // растущая с уровнями сила игрока делала бы их результат плавающим.
    config: { progressionEnabled: false, ...overrides },
  });
}

describe("движение игрока", () => {
  it("разгоняется, а не прыгает на полную скорость за один тик", () => {
    const w = world();
    const right = { moveX: 1, moveY: 0 };

    stepWorld(w, right);
    const afterFirstTick = w.player.vx;

    expect(afterFirstTick).toBeGreaterThan(0);
    expect(afterFirstTick).toBeLessThan(w.config.player.speedPxSec);
  });

  it("выходит на полную скорость примерно за десятую долю секунды", () => {
    const w = world();
    for (let i = 0; i < Math.round(0.12 / TICK_SEC); i++) stepWorld(w, { moveX: 1, moveY: 0 });

    expect(w.player.vx).toBeCloseTo(w.config.player.speedPxSec, 0);
  });

  it("тормозит после отпускания управления, а не останавливается мгновенно", () => {
    const w = world();
    for (let i = 0; i < 30; i++) stepWorld(w, { moveX: 1, moveY: 0 });

    stepWorld(w, IDLE_INPUT);
    expect(w.player.vx).toBeGreaterThan(0);
    expect(w.player.vx).toBeLessThan(w.config.player.speedPxSec);
  });


  it("сохраняет позицию предыдущего тика для интерполяции рендера", () => {
    const w = world();
    for (let i = 0; i < 10; i++) stepWorld(w, { moveX: 1, moveY: 0 });

    expect(w.player.prevX).toBeLessThan(w.player.x);
  });
});

describe("автоатака", () => {
  it("стреляет и на бегу, а не только на остановке", () => {
    const w = world();
    const spawner = createRampSpawner({ startPopulation: 30, addPerSecond: 0, maxPopulation: 30 });

    for (let i = 0; i < 600; i++) {
      spawner.update(w, TICK_SEC);
      stepWorld(w, { moveX: 1, moveY: 0 });
    }

    expect(w.stats.shotsFired).toBeGreaterThan(0);
  });
});

describe("нарастающая нагрузка", () => {
  it("считает цель как старт плюс прирост за секунду", () => {
    const options = { startPopulation: 20, addPerSecond: 2, maxPopulation: 480 };

    expect(rampTargetAt(options, 0)).toBe(20);
    expect(rampTargetAt(options, 10)).toBe(40);
    expect(rampTargetAt(options, 100)).toBe(220);
  });

  it("не растёт выше потолка", () => {
    const options = { startPopulation: 20, addPerSecond: 2, maxPopulation: 60 };
    expect(rampTargetAt(options, 1000)).toBe(60);
  });

  it("наращивает популяцию на экране по ходу прогона", () => {
    const w = world();
    const spawner = createRampSpawner({ startPopulation: 10, addPerSecond: 4, maxPopulation: 200 });

    for (let i = 0; i < 60; i++) {
      spawner.update(w, TICK_SEC);
      stepWorld(w, IDLE_INPUT);
    }
    const afterOneSecond = w.enemies.aliveCount;

    for (let i = 0; i < 60 * 10; i++) {
      spawner.update(w, TICK_SEC);
      stepWorld(w, IDLE_INPUT);
    }

    expect(w.enemies.aliveCount).toBeGreaterThan(afterOneSecond);
  });
});

describe("сетка коллизий вокруг игрока", () => {
  // Сетка больше не строится под размер мира — мира такого размера нет
  // (docs/26-stage2-plan.md, WP4.1). Окно переезжает за игроком, и поиск
  // соседей обязан работать одинаково и в начале координат, и в сотне тысяч
  // единиц от него.
  it("продолжает попадать по врагам после долгого бега в одну сторону", () => {
    const w = world();
    const spawner = createRampSpawner({ startPopulation: 40, addPerSecond: 0, maxPopulation: 40 });
    const away = { moveX: 1, moveY: 0.35 };

    for (let i = 0; i < 60 * 30; i++) {
      spawner.update(w, TICK_SEC);
      stepWorld(w, away);
    }
    const shotsBefore = w.stats.shotsFired;
    const killsBefore = w.stats.enemiesKilled;

    for (let i = 0; i < 60 * 10; i++) {
      spawner.update(w, TICK_SEC);
      stepWorld(w, away);
    }

    expect(Math.abs(w.player.x)).toBeGreaterThan(4000);
    expect(w.stats.shotsFired).toBeGreaterThan(shotsBefore);
    expect(w.stats.enemiesKilled).toBeGreaterThan(killsBefore);
  });
});

describe("плотная толпа", () => {
  it("выделяет буфер запросов под всю ёмкость пула", () => {
    const w = world({ maxEnemies: 4096 });
    // Буфер меньше ёмкости означает молча отброшенных кандидатов: снаряды
    // проходят сквозь врагов, а замер показывает заниженную стоимость
    // коллизий.
    expect(w.queryBuffer.length).toBe(4096);
  });

  it("продолжает попадать по врагам при плотности в сотни объектов", () => {
    const w = world({ maxEnemies: 600 });
    const spawner = createConstantPopulationSpawner(500);

    for (let i = 0; i < 60 * 20; i++) {
      spawner.update(w, TICK_SEC);
      stepWorld(w, IDLE_INPUT);
    }

    expect(w.enemies.aliveCount).toBeGreaterThan(400);
    expect(w.stats.enemiesKilled).toBeGreaterThan(0);
  });
});

describe("плотность экрана", () => {
  it("масштабирует скорости и размеры, а не оставляет игру мелкой на телефоне", () => {
    const normal = world();
    const dense = world({ unitScale: 3 });

    expect(dense.config.player.speedPxSec).toBeCloseTo(normal.config.player.speedPxSec * 3, 5);
    expect(dense.enemyTypes[0].speed).toBeCloseTo(normal.enemyTypes[0].speed * 3, 5);
    expect(dense.enemyTypes[0].radius).toBeCloseTo(normal.enemyTypes[0].radius * 3, 5);
  });

  it("оставляет контент нетронутым: множитель применяется в мире, а не в таблицах", () => {
    world({ unitScale: 3 });
    expect(ENEMIES[0].speed).toBe(90);
  });
});
