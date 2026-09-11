import { describe, expect, it } from "vitest";
import {
  DegradationDetector,
  DEFAULT_DEGRADATION,
  type DegradationOptions,
} from "../src/game/bench/degradation-detector";

// Детектор решает, когда остановить агрессивный прогон и зафиксировать предел
// устройства. Ошибка в любую сторону портит результат: сработает рано —
// запишем случайный фриз как предел, поздно — вместо предела получим замер
// того, как игра мучается на непосильной нагрузке.

/** Прогрев выключен: он проверяется отдельным тестом. */
const NO_WARMUP: Partial<DegradationOptions> = { warmupSec: 0 };

function feed(detector: DegradationDetector, seconds: number, fps: number): boolean {
  const frameMs = 1000 / fps;
  let triggered = false;
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    if (detector.observe(frameMs)) triggered = true;
  }
  return triggered;
}

describe("детектор просадки", () => {
  it("молчит, пока устройство держит нагрузку", () => {
    const detector = new DegradationDetector(NO_WARMUP);

    expect(feed(detector, 60, 60)).toBe(false);
    expect(detector.isDegraded).toBe(false);
  });

  it("останавливает прогон после серии плохих секунд", () => {
    const detector = new DegradationDetector(NO_WARMUP);

    feed(detector, 10, 60);
    expect(detector.isDegraded).toBe(false);

    expect(feed(detector, 4, 35)).toBe(true);
    expect(detector.isDegraded).toBe(true);
  });

  it("не срабатывает на одиночном фризе", () => {
    const detector = new DegradationDetector(NO_WARMUP);

    feed(detector, 5, 60);
    // Секунда провала — ровно то, что даёт пауза сборщика мусора или
    // уведомление в шторке. Это не предел устройства.
    feed(detector, 1, 30);
    feed(detector, 10, 60);

    expect(detector.isDegraded).toBe(false);
  });

  it("обрывает счётчик, если между плохими окнами было хорошее", () => {
    const detector = new DegradationDetector(NO_WARMUP);

    // Дважды по две плохие секунды подряд, разделённые нормальными: серия
    // не набирается, хотя суммарно плохих окон больше порога.
    feed(detector, 2, 35);
    expect(detector.isDegraded).toBe(false);
    feed(detector, 2, 60);
    feed(detector, 2, 35);

    expect(detector.isDegraded).toBe(false);
    expect(detector.badWindows).toBeLessThan(DEFAULT_DEGRADATION.consecutiveWindows);
  });

  it("останавливает немедленно при обвале, не дожидаясь серии", () => {
    const detector = new DegradationDetector(NO_WARMUP);

    feed(detector, 5, 60);
    // 10 FPS — это уже не просадка, а конец; ждать три секунды подтверждения
    // здесь незачем. Двух секунд достаточно, чтобы окно закрылось целиком:
    // первое может смешаться с хвостом предыдущего.
    expect(feed(detector, 2, 10)).toBe(true);
  });

  it("не считает прогрев просадкой", () => {
    const detector = new DegradationDetector({ warmupSec: 5 });

    // Первые пять секунд устройство компилирует шейдеры и грузит текстуры.
    expect(feed(detector, 5, 8)).toBe(false);
    expect(detector.isDegraded).toBe(false);
    expect(feed(detector, 30, 60)).toBe(false);
  });

  it("ловит просадку по p95, когда среднее ещё в норме", () => {
    const detector = new DegradationDetector(NO_WARMUP);

    // Средний FPS около 55 — порог по среднему не сработал бы, но каждый
    // десятый кадр по 40 мс виден глазом как рывок.
    for (let second = 0; second < 5; second++) {
      for (let i = 0; i < 55; i++) detector.observe(i % 10 === 0 ? 40 : 15);
    }

    expect(detector.isDegraded).toBe(true);
  });

  it("держит разумные значения по умолчанию", () => {
    expect(DEFAULT_DEGRADATION.minAvgFps).toBe(50);
    expect(DEFAULT_DEGRADATION.consecutiveWindows).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_DEGRADATION.warmupSec).toBeGreaterThan(0);
  });
});
