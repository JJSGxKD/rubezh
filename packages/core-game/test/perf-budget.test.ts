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
// Ориентир: локальный прогон укладывается примерно в 110 мс, то есть запас
// семикратный. Возврат к попарной проверке коллизий съедает его целиком.
//
// Было около 80 мс до бесконечного мира (WP4): сетка коллизий больше не
// повторяет размер канвы, а накрывает радиус удержания вокруг игрока — это
// на порядок больше клеток, и каждый тик они обнуляются и пересобираются.
// Размен сознательный: без него в бесконечном мире сетки не существует вовсе.

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

// Запись забега (docs/28-diagnostics.md §3.5): бюджет на устройстве — 0.2 мс
// на кадр в среднем на бюджетном Android. Здесь — детектор регрессий того же
// рода: сортировка кадров на каждом кадре вместо раза в корзину или рост
// аллокаций видны сразу. Бюджетный Android медленнее рабочей машины раз в
// двадцать, поэтому порог на рабочей машине — сотая доля миллисекунды на кадр.
//
// Ориентир: локальный прогон — около 11 мс на все кадры, запас тридцатикратный.
const RECORDED_FRAMES = 36_000; // десять минут при 60 Гц
const RECORDER_BUDGET_MS = RECORDED_FRAMES * 0.01;

describe("бюджет накладных расходов записи забега", () => {
  it(`пишет ${RECORDED_FRAMES} кадров быстрее ${RECORDER_BUDGET_MS} мс`, async () => {
    const { RunRecorder } = await import("../src/game/diagnostics/run-recorder");
    const { createRunWorld } = await import("../src/game/run-world");
    const { world } = createRunWorld({ seed: 1, mapId: "", difficultyId: "normal", unitScale: 2 });
    const recorder = new RunRecorder({
      reportId: "00000000-0000-4000-8000-000000000003",
      runId: "overhead",
      startedAt: "2026-09-16T10:00:00.000Z",
      seed: 1,
      mapId: world.mapId,
      difficultyId: "normal",
      startingWeaponId: "spark",
      contentHash: "hash",
      unitScale: 2,
      replayBlocker: null,
    });

    const startedAt = performance.now();
    for (let tick = 1; tick <= RECORDED_FRAMES; tick++) {
      world.stats.tick = tick;
      recorder.stepped(tick % 3 === 0 ? (tick >> 2) % 256 : -1, world);
      recorder.frame({ frameMs: 16 + (tick % 7), simMs: 2, steps: 1, renderMs: 3, enemies: 500, projectiles: 100, tick, wave: 3 });
    }
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(RECORDER_BUDGET_MS);
  });
});
