import { describe, expect, it } from "vitest";
import { createRng } from "../src/game/sim/rng";
import { ALL_PATTERNS_WEIGHTS, runScripted } from "./helpers/scripted-run";

// Детерминизм — предусловие всей стратегии тестирования
// (docs/17-testing-strategy.md §3.0). Сломается он — молча перестанут иметь
// смысл golden-прогоны баланса и воспроизведение багов по seed'у.

describe("генератор случайных чисел", () => {
  it("выдаёт одну и ту же последовательность на одном seed", () => {
    const first = Array.from({ length: 16 }, () => createRng(1337).nextUint32());
    const second = Array.from({ length: 16 }, () => createRng(1337).nextUint32());
    expect(first).toEqual(second);
  });

  it("выдаёт разные последовательности на разных seed", () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a.nextUint32()).not.toBe(b.nextUint32());
  });

  it("восстанавливает последовательность из сохранённого состояния", () => {
    const rng = createRng(99);
    for (let i = 0; i < 10; i++) rng.nextUint32();
    const saved = rng.getState();
    const expected = [rng.nextUint32(), rng.nextUint32()];

    rng.setState(saved);
    expect([rng.nextUint32(), rng.nextUint32()]).toEqual(expected);
  });

  it("держит nextFloat в границах [0, 1)", () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("симуляция", () => {
  it("даёт побитово одинаковый результат на одном seed и одном скрипте ввода", () => {
    const first = runScripted({ seed: 20260910, ticks: 1800, population: 60 });
    const second = runScripted({ seed: 20260910, ticks: 1800, population: 60 });

    expect(second.checksum).toBe(first.checksum);
    expect(second.world.stats).toEqual(first.world.stats);
  });

  it("остаётся детерминированной со всеми паттернами: фазы, рывки, взрывы, распад", () => {
    const options = { seed: 20260912, ticks: 3600, population: 80, weights: ALL_PATTERNS_WEIGHTS };
    const first = runScripted(options);
    const second = runScripted(options);

    // Прогон должен задействовать реакции паттернов, иначе проверка пустая.
    expect(first.world.stats.enemiesSpawned).toBeGreaterThan(80);
    expect(first.world.events.written).toBeGreaterThan(0);
    expect(second.checksum).toBe(first.checksum);
    expect(second.world.stats).toEqual(first.world.stats);
  });

  /**
   * Эталонная контрольная сумма забега — та самая, с которой сверяется прогон
   * на другом JS-движке (docs/26-stage2-plan.md, WP4.5).
   *
   * V8 на Android и в CI даёт это число здесь и сейчас. JavaScriptCore на iOS
   * обязан дать то же: вся математика симуляции — сложение, умножение и
   * `Math.sqrt`, то есть точные по IEEE 754 операции; приближённые `sin`,
   * `cos` и `pow` из этого слоя вычищены и запрещены `sim-purity.test.ts`.
   * Сверка на устройстве — пункт ручного QA (WP11), эта строка — его эталон.
   *
   * Число меняется при любой правке симуляции или контента. Это не повод его
   * «подвинуть»: сначала человек смотрит, ожидал ли он такой правки.
   */
  it("совпадает с эталонной контрольной суммой забега", () => {
    const run = runScripted({
      seed: 20260912,
      ticks: 3600,
      population: 80,
      weights: ALL_PATTERNS_WEIGHTS,
      immortalPlayer: true,
    });

    // Эталон обновлён вместе с боссами: в смеси паттернов прогона появился
    // кастующий, и порядок обращений к генератору сместился с первой же
    // секунды.
    expect(run.checksum).toBe(-584561969);
    expect(run.world.stats.enemiesKilled).toBe(431);
    expect(run.world.progression.level).toBe(18);
  });

  it("расходится на другом seed — иначе seed ни на что не влияет", () => {
    const first = runScripted({ seed: 1, ticks: 900, population: 60 });
    const second = runScripted({ seed: 2, ticks: 900, population: 60 });
    expect(second.checksum).not.toBe(first.checksum);
  });

  it("действительно нагружает мир, а не крутит пустой цикл", () => {
    const run = runScripted({ seed: 42, ticks: 1800, population: 60, immortalPlayer: true });

    expect(run.world.enemies.aliveCount).toBeGreaterThan(0);
    expect(run.world.stats.shotsFired).toBeGreaterThan(0);
    expect(run.world.stats.enemiesKilled).toBeGreaterThan(0);
  });
});
