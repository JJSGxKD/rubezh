import { describe, expect, it } from "vitest";
import { ALL_PATTERNS_WEIGHTS, runScripted } from "./helpers/scripted-run";

// Бюджет производительности (docs/17-testing-strategy.md §3.4).
//
// Это НЕ замена FPS-тесту на устройстве — это детектор алгоритмических
// регрессий: возврат к попарной проверке коллизий вместо пространственной
// сетки виден здесь через минуту, а не на бюджетном Android за две недели
// до лонча.
//
// Порог задан с большим запасом относительно локального прогона: тест должен
// падать от смены сложности алгоритма, а не от шума раннера CI. Пересмотр
// порога — осознанное решение в PR, а не «подвинуть, раз покраснело».
//
// Ориентир на момент установки: локальный прогон укладывается примерно в
// 80 мс, то есть запас десятикратный. Возврат к попарной проверке коллизий
// съедает его целиком.

const TICKS = 3600; // одна минута игрового времени при 60 Гц
const POPULATION = 100; // столько врагов требует критерий готовности недели 1
const BUDGET_MS = 800;

describe("бюджет производительности симуляции", () => {
  it(`прогоняет ${POPULATION} врагов ${TICKS} тиков быстрее ${BUDGET_MS} мс`, () => {
    const startedAt = performance.now();
    const run = runScripted({
      seed: 4242,
      ticks: TICKS,
      population: POPULATION,
      immortalPlayer: true,
    });
    const elapsedMs = performance.now() - startedAt;

    // Прогон должен быть настоящим: если популяция не набралась, меряется пустота.
    expect(run.world.enemies.aliveCount).toBeGreaterThanOrEqual(POPULATION - 10);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  // Смесь стенда этапа 1 — только рой, преследование и стрелок. Игра создаёт
  // другую нагрузку: фазы рывка, орбиты, взрывы и распад на потомков. Бюджет
  // тот же — новый паттерн не имеет права сделать симуляцию алгоритмически
  // дороже старых.
  it(`прогоняет ${POPULATION} врагов всех паттернов ${TICKS} тиков быстрее ${BUDGET_MS} мс`, () => {
    const startedAt = performance.now();
    const run = runScripted({
      seed: 4243,
      ticks: TICKS,
      population: POPULATION,
      immortalPlayer: true,
      weights: ALL_PATTERNS_WEIGHTS,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(run.world.enemies.aliveCount).toBeGreaterThanOrEqual(POPULATION - 10);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });
});
