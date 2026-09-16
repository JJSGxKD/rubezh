import { describe, expect, it } from "vitest";
import {
  FrameRecorder,
  type BenchDevice,
  type BenchProfile,
} from "../src/game/bench/metrics";
import { evaluateBench, WEEK1_THRESHOLDS, type BenchThresholds } from "../src/game/bench/verdict";

// Измеритель — это инструмент, по которому принимается решение go/no-go.
// Ошибка в нём стоит дороже ошибки в игре: она уводит не в баг, а в неверное
// архитектурное решение.

const PROFILE: BenchProfile = {
  mode: "stress",
  targetPopulation: 4000,
  addPerSecond: 20,
  seed: 42,
  durationSec: 180,
  buildVersion: "test",
  canvasWidth: 1080,
  canvasHeight: 1920,
  devicePixelRatio: 3,
  renderer: "WEBGL",
  loadout: "full",
};

const DEVICE: BenchDevice = {
  userAgent: "test",
  platform: "test",
  hardwareConcurrency: 8,
  deviceMemoryGb: 4,
  screenWidth: 1080,
  screenHeight: 1920,
  devicePixelRatio: 3,
  telegramPlatform: "android",
  telegramVersion: "7.0",
  telegramUserId: "1",
  telegramLanguage: "ru",
  telegramIsPremium: false,
  telegramFullscreen: false,
};

const STARTED_AT = "2026-09-10T12:00:00.000Z";

/** Короткие пороги: длительность проверяется отдельным тестом. */
const FAST_THRESHOLDS: BenchThresholds = { ...WEEK1_THRESHOLDS, minDurationSec: 10 };

function recordSeconds(
  recorder: FrameRecorder,
  seconds: number,
  fps: number,
  load = 0,
  projectiles = 0,
): void {
  const frameMs = 1000 / fps;
  for (let i = 0; i < Math.round(seconds * fps); i++) recorder.record(frameMs, load, projectiles);
}

describe("сбор метрик кадра", () => {
  it("считает средний FPS по времени кадров, а не по их числу", () => {
    const recorder = new FrameRecorder();
    recordSeconds(recorder, 10, 60);

    const report = recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration");
    expect(report.totals.avgFps).toBeCloseTo(60, 0);
    expect(report.totals.durationSec).toBeCloseTo(10, 1);
  });

  it("показывает редкие фризы в перцентилях, которые прячет среднее", () => {
    const recorder = new FrameRecorder();
    // 99 ровных кадров и один фриз на 100 мс: среднее почти не шевельнётся
    for (let i = 0; i < 99; i++) recorder.record(16);
    recorder.record(100);

    const report = recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration");
    expect(report.totals.p50FrameMs).toBe(16);
    expect(report.totals.minFps).toBeCloseTo(10, 0);
    expect(report.totals.over33Ratio).toBeCloseTo(0.01, 3);
  });

  it("режет прогон на окна и видит деградацию к концу", () => {
    const recorder = new FrameRecorder(30);
    recordSeconds(recorder, 30, 60);
    recordSeconds(recorder, 30, 30);

    const report = recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration");
    expect(report.windows.length).toBe(2);
    expect(report.windows[0].avgFps).toBeGreaterThan(55);
    expect(report.windows[1].avgFps).toBeLessThan(35);
    expect(report.totals.degradationRatio).toBeGreaterThan(0.4);
  });

  it("пишет нагрузку рядом с каждым кадром и отдаёт её в таймлайне", () => {
    const recorder = new FrameRecorder(30, 5);
    recordSeconds(recorder, 5, 60, 50);
    recordSeconds(recorder, 5, 60, 150);

    const report = recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration");
    expect(report.timeline.length).toBe(2);
    expect(report.timeline[0].load).toBeCloseTo(50, 0);
    expect(report.timeline[1].load).toBeCloseTo(150, 0);
    expect(report.totals.peakLoad).toBe(150);
  });

  it("считает пик объектов как пик суммы, а не сумму пиков", () => {
    const recorder = new FrameRecorder(30, 5);
    // Враги на максимуме в первой корзине, снаряды — во второй. Сумма пиков
    // дала бы 300, но одновременно на экране столько не было ни разу.
    recordSeconds(recorder, 5, 60, 200, 20);
    recordSeconds(recorder, 5, 60, 50, 100);

    const totals = recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration").totals;
    expect(totals.peakLoad).toBe(200);
    expect(totals.peakProjectiles).toBe(100);
    expect(totals.peakObjects).toBe(220);
  });

  it("оценивает частоту экрана по началу прогона", () => {
    const recorder = new FrameRecorder();
    recordSeconds(recorder, 10, 120, 50);

    expect(recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration").totals.displayHz).toBe(
      120,
    );
  });

  it("считает прерывания прогона", () => {
    const recorder = new FrameRecorder();
    recordSeconds(recorder, 10, 60, 50);

    expect(
      recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration", 2).interruptions,
    ).toBe(2);
  });

  it("сохраняет причину остановки прогона", () => {
    const recorder = new FrameRecorder();
    recordSeconds(recorder, 10, 60, 100);

    expect(recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "degradation").stoppedBy).toBe(
      "degradation",
    );
  });

  it("сообщает о переполнении буфера вместо тихой потери кадров", () => {
    const recorder = new FrameRecorder(30, 5, 10);
    recordSeconds(recorder, 1, 20);

    expect(recorder.frameCount).toBe(10);
    expect(recorder.isOverflowed).toBe(true);
  });
});

describe("вердикт по критерию недели 1", () => {
  it("находит нагрузку, на которой начинается просадка", () => {
    const recorder = new FrameRecorder(30, 5);
    recordSeconds(recorder, 5, 30, 10); // прогрев: этот провал не считается
    recordSeconds(recorder, 5, 60, 60);
    recordSeconds(recorder, 5, 60, 120);
    recordSeconds(recorder, 5, 32, 180); // здесь устройство ломается

    const verdict = evaluateBench(
      recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration"),
      FAST_THRESHOLDS,
    );

    expect(verdict.sustainedLoad).toBeCloseTo(120, 0);
    expect(verdict.breakingPoint?.load).toBeCloseTo(180, 0);
    expect(verdict.level).toBe("go");
  });

  it("даёт no-go, когда просадка начинается раньше требуемой нагрузки", () => {
    const recorder = new FrameRecorder(30, 5);
    recordSeconds(recorder, 5, 60, 10);
    recordSeconds(recorder, 5, 60, 40);
    recordSeconds(recorder, 10, 28, 70);

    const verdict = evaluateBench(
      recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration"),
      FAST_THRESHOLDS,
    );

    expect(verdict.sustainedLoad).toBeCloseTo(40, 0);
    expect(verdict.level).toBe("no-go");
    expect(verdict.failures.join(" ")).toMatch(/Держит только/);
  });

  it("не считает просадкой прогрев на первой корзине", () => {
    const recorder = new FrameRecorder(30, 5);
    recordSeconds(recorder, 5, 20, 100); // компиляция шейдеров и загрузка текстур
    recordSeconds(recorder, 15, 60, 120);

    const verdict = evaluateBench(
      recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration"),
      FAST_THRESHOLDS,
    );

    expect(verdict.breakingPoint).toBeNull();
    expect(verdict.sustainedLoad).toBeCloseTo(120, 0);
  });

  it("не называет троттлингом падение FPS при растущей нагрузке", () => {
    const recorder = new FrameRecorder(30, 5);
    // 120-герцовый экран: прогон стартует со 120 FPS и по мере роста нагрузки
    // сползает к 60. Это предмет измерения, а не перегрев устройства.
    recordSeconds(recorder, 150, 120, 500);
    recordSeconds(recorder, 60, 60, 2500);

    const verdict = evaluateBench(recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration"));

    expect(verdict.failures).toEqual([]);
    expect(verdict.level).toBe("go");
  });

  it("считает короткий прогон результатом, если он остановлен просадкой", () => {
    const recorder = new FrameRecorder(30, 5);
    recordSeconds(recorder, 5, 60, 100); // прогрев
    recordSeconds(recorder, 25, 60, 800);
    recordSeconds(recorder, 5, 30, 1200);

    // Тридцать пять секунд вместо ста пятидесяти — но прогон не оборвался,
    // а нашёл предел, ради которого и запускался.
    const verdict = evaluateBench(
      recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "degradation"),
    );

    expect(verdict.level).not.toBe("invalid");
    // Точное значение зависит от того, где легли границы корзин относительно
    // смены нагрузки, поэтому проверяется диапазон, а не число.
    expect(verdict.sustainedLoad).toBeGreaterThanOrEqual(800);
    expect(verdict.sustainedLoad).toBeLessThan(900);
    expect(verdict.breakingPoint?.load).toBeGreaterThan(1000);
  });

  it("остаётся строгим к короткому прогону, оборванному вручную", () => {
    const recorder = new FrameRecorder(30, 5);
    recordSeconds(recorder, 30, 60, 800);

    const verdict = evaluateBench(recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "manual"));
    expect(verdict.level).toBe("invalid");
  });

  it("считает сотню врагов сотней, а не 99.99 из-за усреднения", () => {
    const recorder = new FrameRecorder(30, 5);
    recordSeconds(recorder, 5, 60, 40); // прогрев
    // На экране ровно сто врагов, но один кадр застал 99 — среднее по корзине
    // выходит 99.99, и сравнение сырого среднего с целым порогом давало
    // «держит только 100 при требуемых 100».
    recordSeconds(recorder, 20, 60, 100);
    recorder.record(1000 / 60, 99);

    const verdict = evaluateBench(
      recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration"),
      FAST_THRESHOLDS,
    );

    expect(verdict.sustainedLoad).toBe(100);
    expect(verdict.failures).toEqual([]);
    expect(verdict.level).toBe("go");
  });

  it("отличает слишком короткий прогон от провала", () => {
    const recorder = new FrameRecorder();
    recordSeconds(recorder, 10, 60, 200);

    const verdict = evaluateBench(recorder.buildReport(PROFILE, DEVICE, STARTED_AT, "duration"));
    expect(verdict.level).toBe("invalid");
    expect(verdict.sustainedLoad).toBe(0);
  });
});
