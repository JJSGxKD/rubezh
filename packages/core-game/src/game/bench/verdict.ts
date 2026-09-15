import type { BenchReport, TimelineBucket } from "./metrics";

/**
 * Критерий готовности недели 1 из роадмапа — «стабильные 50+ FPS на бюджетном
 * устройстве при 100 врагах на экране» — переведён в проверяемые числа.
 *
 * Пороги зафиксированы ДО прогонов сознательно: критерий, который
 * досочиняют после того, как увидели цифры, не является критерием.
 */
export interface BenchThresholds {
  /** средний FPS в корзине таймлайна, ниже которого нагрузка считается непосильной */
  minAvgFps: number;
  /** 95-й перцентиль времени кадра: 20 мс — это ровно 50 FPS */
  maxP95FrameMs: number;
  /** доля кадров дольше 33 мс, считается по прогону без прогрева */
  maxOver33Ratio: number;
  /** нагрузка, которую устройство обязано держать: цифра из критерия недели 1 */
  minSustainedLoad: number;
  /** прогон короче этого не считается прогоном: троттлинг не успевает начаться */
  minDurationSec: number;
}

export const WEEK1_THRESHOLDS: BenchThresholds = {
  minAvgFps: 50,
  maxP95FrameMs: 20,
  maxOver33Ratio: 0.01,
  minSustainedLoad: 100,
  minDurationSec: 150,
};

export type VerdictLevel = "go" | "no-go" | "invalid";

/** Момент, где устройство перестало держать нагрузку. */
export interface BreakingPoint {
  atSec: number;
  load: number;
  avgFps: number;
  p95FrameMs: number;
}

export interface BenchVerdict {
  level: VerdictLevel;
  /** наибольшая нагрузка, которую устройство держало в пределах порогов */
  sustainedLoad: number;
  /** null означает, что до конца прогона порог так и не был пробит */
  breakingPoint: BreakingPoint | null;
  /** человекочитаемые причины отказа — они же попадают в отчёт */
  failures: string[];
}

/**
 * Первая корзина таймлайна не учитывается: там компиляция шейдеров, загрузка
 * текстур и прогрев JIT. Считать этот всплеск просадкой производительности —
 * значит объявлять no-go по стартовой заставке.
 */
const WARMUP_BUCKETS = 1;

/**
 * Сколько корзин после прогрева нужно, чтобы прогон, прерванный просадкой,
 * считался состоявшимся. Прогон, остановленный на двадцатой секунде, — это
 * найденный предел, а не брак, и требовать от него полных трёх минут нельзя.
 */
const MIN_BUCKETS_AFTER_WARMUP = 3;

export function evaluateBench(
  report: BenchReport,
  thresholds: BenchThresholds = WEEK1_THRESHOLDS,
): BenchVerdict {
  const totals = report.totals;

  // Слишком короткий прогон — не «no-go», а отсутствие результата.
  // Разница принципиальная: no-go означает менять подход к рендеру.
  //
  // Исключение — прогон, который стенд остановил сам по подтверждённой
  // просадке: это не обрыв, а достигнутая цель. Требование трёх минут писалось
  // под режим с фиксированной нагрузкой этапа 1, где короткий прогон означал,
  // что троттлинг не успел проявиться.
  const stoppedAtLimit =
    report.stoppedBy === "degradation" &&
    report.timeline.length >= WARMUP_BUCKETS + MIN_BUCKETS_AFTER_WARMUP;

  if (!stoppedAtLimit && totals.durationSec < thresholds.minDurationSec) {
    return {
      level: "invalid",
      sustainedLoad: 0,
      breakingPoint: null,
      failures: [
        `Прогон длился ${totals.durationSec.toFixed(0)} с при минимуме ${thresholds.minDurationSec} с — троттлинг не успевает проявиться`,
      ],
    };
  }

  const { sustainedLoad, breakingPoint } = findBreakingPoint(report.timeline, thresholds);
  const failures: string[] = [];

  if (sustainedLoad < thresholds.minSustainedLoad) {
    failures.push(
      `Держит только ${sustainedLoad} врагов при требуемых ${thresholds.minSustainedLoad}`,
    );
  }
  // Доля рывков считается по таймлайну без прогрева, а не по totals: иначе
  // всплеск на компиляции шейдеров один роняет весь прогон в no-go.
  const over33Ratio = ratioOver33AfterWarmup(report.timeline);
  if (over33Ratio > thresholds.maxOver33Ratio) {
    failures.push(
      `Кадров дольше 33 мс: ${(over33Ratio * 100).toFixed(2)}% при допуске ${(thresholds.maxOver33Ratio * 100).toFixed(2)}%`,
    );
  }
  // Падение FPS к концу прогона троттлингом не считается: нагрузка растёт, и
  // FPS обязан падать — это и есть предмет измерения. Особенно ярко это на
  // 120-герцовом экране: прогон стартует со 120 FPS и «теряет» половину, просто
  // дойдя до 60. Троттлинг мерили режимом с постоянной нагрузкой этапа 1.

  return {
    level: failures.length === 0 ? "go" : "no-go",
    sustainedLoad,
    breakingPoint,
    failures,
  };
}

function ratioOver33AfterWarmup(timeline: TimelineBucket[]): number {
  let frames = 0;
  let over33 = 0;

  for (const bucket of timeline) {
    if (bucket.index < WARMUP_BUCKETS) continue;
    frames += bucket.frames;
    over33 += bucket.over33Ratio * bucket.frames;
  }

  return frames === 0 ? 0 : over33 / frames;
}

/**
 * Идём по таймлайну и ищем первую корзину, где пороги не выдержаны.
 *
 * Важно, что нагрузка берётся из **фактического** числа врагов на экране, а
 * не из цели спавнера: если устройство просело настолько, что спавнер не
 * успевает пополнять популяцию, честная цифра — та, что была на экране.
 */
function findBreakingPoint(
  timeline: TimelineBucket[],
  thresholds: BenchThresholds,
): { sustainedLoad: number; breakingPoint: BreakingPoint | null } {
  let sustainedLoad = 0;

  for (const bucket of timeline) {
    if (bucket.index < WARMUP_BUCKETS || bucket.frames === 0) continue;

    const holds =
      bucket.avgFps >= thresholds.minAvgFps && bucket.p95FrameMs <= thresholds.maxP95FrameMs;

    if (!holds) {
      return {
        sustainedLoad,
        breakingPoint: {
          atSec: bucket.startSec,
          load: bucket.load,
          avgFps: bucket.avgFps,
          p95FrameMs: bucket.p95FrameMs,
        },
      };
    }

    // Округление обязательно: нагрузка в корзине — среднее по кадрам, и сотня
    // врагов на экране даёт 99.993. Сравнение сырого среднего с целым порогом
    // давало «держит только 100 врагов при требуемых 100».
    const load = Math.round(bucket.load);
    if (load > sustainedLoad) sustainedLoad = load;
  }

  return { sustainedLoad, breakingPoint: null };
}
