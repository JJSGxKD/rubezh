/**
 * Статистика кадров — общая для стресс-теста, сводки обычного забега и полной
 * записи (docs/28-diagnostics.md §3.1). Протокол выверен на FPS-испытаниях
 * этапа 1 (docs/25-week1-fps-trials.md §1.5): считаем по сырому времени
 * кадра, перцентили — ближайшим рангом, частоту экрана — медианой начала.
 *
 * Модуль не знает ни про Phaser, ни про DOM и проверяется на синтетических
 * кадрах.
 */

export interface FrameStats {
  frames: number;
  durationSec: number;
  avgFps: number;
  /** FPS по самому долгому кадру — сколько было в худший момент */
  minFps: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  /** доля кадров дольше 33 мс — заметные глазу рывки */
  over33Ratio: number;
}

/** Порог «заметного рывка»: кадр дольше двух кадров при 60 Гц. */
export const JANK_FRAME_MS = 33;

export function summarizeFrames(frames: Float32Array): FrameStats {
  if (frames.length === 0) {
    return {
      frames: 0,
      durationSec: 0,
      avgFps: 0,
      minFps: 0,
      p50FrameMs: 0,
      p95FrameMs: 0,
      p99FrameMs: 0,
      over33Ratio: 0,
    };
  }

  let totalMs = 0;
  let worstFrameMs = 0;
  for (let i = 0; i < frames.length; i++) {
    totalMs += frames[i];
    if (frames[i] > worstFrameMs) worstFrameMs = frames[i];
  }

  const sorted = Float32Array.from(frames).sort();

  return {
    frames: frames.length,
    durationSec: totalMs / 1000,
    avgFps: frames.length / (totalMs / 1000),
    minFps: worstFrameMs > 0 ? 1000 / worstFrameMs : 0,
    p50FrameMs: percentileOfSorted(sorted, 0.5),
    p95FrameMs: percentileOfSorted(sorted, 0.95),
    p99FrameMs: percentileOfSorted(sorted, 0.99),
    over33Ratio: ratioOver(frames, JANK_FRAME_MS),
  };
}

/** Ближайший ранг: без интерполяции — значение перцентиля реально встречалось. */
export function percentileOfSorted(sorted: Float32Array, fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

export function ratioOver(frames: Float32Array, thresholdMs: number): number {
  if (frames.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i] > thresholdMs) count++;
  }
  return count / frames.length;
}

export function average(values: Float32Array): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  return total / values.length;
}

export function maximum(values: Float32Array): number {
  let best = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > best) best = values[i];
  }
  return best;
}

/** Пик суммы, а не сумма пиков: две величины выходят на максимум в разные моменты. */
export function maximumSum(first: Float32Array, second: Float32Array): number {
  let best = 0;
  for (let i = 0; i < first.length; i++) {
    const sum = first[i] + second[i];
    if (sum > best) best = sum;
  }
  return best;
}

/** Сколько кадров пропустить от начала, прежде чем оценивать частоту экрана. */
export const DISPLAY_HZ_SKIP_FRAMES = 30;
/** Сколько кадров взять в оценку: при 60 Гц — четыре секунды. */
export const DISPLAY_HZ_SAMPLE_FRAMES = 240;

/**
 * Частота экрана — по медиане кадров из начала: там нагрузка ещё минимальна, и
 * время кадра упирается в вертикальную синхронизацию, а не в отрисовку.
 * Медиана, а не среднее — чтобы один долгий кадр на старте не сбивал оценку.
 * Самое начало пропускается: там ещё компилируются шейдеры.
 *
 * Браузер частоту не сообщает, а знать надо: на 120-герцовом экране «60 FPS»
 * означает вдвое худший результат, чем на 60-герцовом.
 */
export function estimateDisplayHz(frames: Float32Array): number {
  if (frames.length === 0) return 0;
  const from = Math.min(DISPLAY_HZ_SKIP_FRAMES, frames.length - 1);
  const to = Math.min(from + DISPLAY_HZ_SAMPLE_FRAMES, frames.length);
  const sample = Float32Array.from(frames.subarray(from, to)).sort();
  const median = sample[Math.floor(sample.length / 2)];
  return median > 0 ? Math.round(1000 / median) : 0;
}
