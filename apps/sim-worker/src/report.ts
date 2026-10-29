import type { BalanceTargetsDef, ContentSnapshot } from "@bh/core-game/src/content/snapshot";
import { quantile, summarizeRuns, type BalanceRunResult } from "@bh/core-game/src/game/balance";

/** Проблема снимка: путь до поля и сообщение по-русски. */
export interface Problem {
  path: string;
  message: string;
}

/** Медианы сценария по зёрнам: то, что показывает отчёт и с чем сравнивается база. */
export interface ScenarioMedians {
  /** время жизни: секунды до смерти — у бота она одна, это и есть «время до первой смерти» */
  survivalSec: number;
  firstLevelUpSec: number;
  level: number;
  kills: number;
  chestsOpened: number;
}

export interface ScenarioReport {
  id: string;
  skill: "passive" | "dodging";
  startingWeaponId: string | null;
  difficultyId: string;
  accountLevel: number | null;
  seeds: number;
  draft: ScenarioMedians | null;
  base: ScenarioMedians | null;
  /** черновик минус база */
  delta: ScenarioMedians | null;
  /** сценарий не посчитался: что сломалось, по-русски */
  error: string | null;
  /** предел времени вышел раньше, чем сценарий досчитался */
  skipped: boolean;
}

export type Verdict = "in" | "below" | "above";

export interface CorridorSide {
  value: number;
  verdict: Verdict;
}

export type CorridorId = "passiveDeathBeforeSec" | "dodgingMedianSec" | "dodgingDeathsBeforeMinuteRatioMax" | "firstLevelUpSec" | "firstChestEventSec";

export interface CorridorReport {
  id: CorridorId;
  title: string;
  /** границы коридора черновика; `null` — границы с этой стороны нет */
  corridor: { min: number | null; max: number | null };
  /** границы коридора базы: правка цели видна и здесь */
  baseCorridor: { min: number | null; max: number | null };
  /** `null` — посчитать не из чего: нет подходящего сценария или он не досчитался */
  draft: CorridorSide | null;
  base: CorridorSide | null;
}

export interface CheckReport {
  /** прогон не уложился в предел времени: не досчитанное помечено `skipped` */
  timeout: boolean;
  seeds: number;
  scenarios: ScenarioReport[];
  corridors: CorridorReport[];
}

export interface CheckResult {
  checkId: string;
  schemaProblems: Problem[];
  contentProblems: Problem[];
  report: CheckReport | null;
  elapsedMs: number;
}

/** Нуль без знака: `-0` в отчёте читается как отличие, а его нет. */
const clean = (value: number): number => (Object.is(value, -0) ? 0 : Math.round(value * 1_000_000) / 1_000_000);

export function mediansOf(runs: readonly BalanceRunResult[]): ScenarioMedians {
  const summary = summarizeRuns(runs);
  const kills = runs.map((run) => run.enemiesKilled).sort((a, b) => a - b);
  return {
    survivalSec: summary.medianSurvivalSec,
    firstLevelUpSec: summary.medianFirstLevelUpSec,
    level: summary.medianLevel,
    kills: quantile(kills, 0.5),
    chestsOpened: summary.medianChestsOpened,
  };
}

export function deltaOf(draft: ScenarioMedians, base: ScenarioMedians): ScenarioMedians {
  return {
    survivalSec: clean(draft.survivalSec - base.survivalSec),
    firstLevelUpSec: clean(draft.firstLevelUpSec - base.firstLevelUpSec),
    level: clean(draft.level - base.level),
    kills: clean(draft.kills - base.kills),
    chestsOpened: clean(draft.chestsOpened - base.chestsOpened),
  };
}

function rangeVerdict(value: number, range: { min: number; max: number }): Verdict {
  return value < range.min ? "below" : value > range.max ? "above" : "in";
}

/** Прогоны одной стороны — черновика или базы — для коридоров: «Лёгкая», без уровня аккаунта, как в своде калибровки. */
export interface SideRuns {
  passive: readonly BalanceRunResult[];
  dodging: readonly BalanceRunResult[];
  /** сценарии каждого вида досчитаны все */
  complete: { passive: boolean; dodging: boolean };
}

/**
 * Первое событие элиты или босса в таймлайне — с него падает первый сундук. Это
 * свойство содержимого снимка, а не прогона: те же правила, что у проверки
 * контента `findFirstChestProblems`.
 */
export function firstChestEventSec(content: ContentSnapshot): number | null {
  const ranked = new Set(content.enemies.filter((enemy) => enemy.rank !== undefined).map((enemy) => enemy.id));
  const seconds = content.timeline.filter((segment) => (segment.events ?? []).some((event) => ranked.has(event.enemy))).map((segment) => segment.fromSec);
  return seconds.length === 0 ? null : Math.min(...seconds);
}

function side(runs: SideRuns | null, content: ContentSnapshot, id: CorridorId): CorridorSide | null {
  const targets: BalanceTargetsDef = content.balanceTargets;
  if (id === "firstChestEventSec") {
    const value = firstChestEventSec(content);
    return value === null ? null : { value, verdict: rangeVerdict(value, targets.firstChestEventSec) };
  }
  if (runs === null) return null;
  if (id === "passiveDeathBeforeSec") {
    if (runs.passive.length === 0 || !runs.complete.passive) return null;
    const value = summarizeRuns(runs.passive).p90SurvivalSec;
    return { value, verdict: value < targets.passiveDeathBeforeSec ? "in" : "above" };
  }
  if (runs.dodging.length === 0 || !runs.complete.dodging) return null;
  const summary = summarizeRuns(runs.dodging);
  if (id === "dodgingMedianSec") return { value: summary.medianSurvivalSec, verdict: rangeVerdict(summary.medianSurvivalSec, targets.dodgingMedianSec) };
  if (id === "dodgingDeathsBeforeMinuteRatioMax") {
    return { value: summary.deathsBeforeMinuteRatio, verdict: summary.deathsBeforeMinuteRatio <= targets.dodgingDeathsBeforeMinuteRatioMax ? "in" : "above" };
  }
  return { value: summary.medianFirstLevelUpSec, verdict: rangeVerdict(summary.medianFirstLevelUpSec, targets.firstLevelUpSec) };
}

function corridorBounds(content: ContentSnapshot): Record<CorridorId, { min: number | null; max: number | null }> {
  const targets = content.balanceTargets;
  return {
    passiveDeathBeforeSec: { min: null, max: targets.passiveDeathBeforeSec },
    dodgingMedianSec: { min: targets.dodgingMedianSec.min, max: targets.dodgingMedianSec.max },
    dodgingDeathsBeforeMinuteRatioMax: { min: null, max: targets.dodgingDeathsBeforeMinuteRatioMax },
    firstLevelUpSec: { min: targets.firstLevelUpSec.min, max: targets.firstLevelUpSec.max },
    firstChestEventSec: { min: targets.firstChestEventSec.min, max: targets.firstChestEventSec.max },
  };
}

const CORRIDOR_TITLES: Record<CorridorId, string> = {
  passiveDeathBeforeSec: "Пассивный бот: смерть до порога, с (p90)",
  dodgingMedianSec: "Уклоняющийся бот: медиана жизни, с",
  dodgingDeathsBeforeMinuteRatioMax: "Уклоняющийся бот: доля смертей до минуты",
  firstLevelUpSec: "Уклоняющийся бот: первый уровень, с (медиана)",
  firstChestEventSec: "Первое событие элиты или босса (первый сундук), с",
};

/**
 * Сравнение с коридорами `balance-targets`: в коридоре, ниже или выше. Каждая
 * сторона — со своими коридорами, черновик с черновиковыми, база с базовыми:
 * правка самой цели тоже часть правки, и вердикт должен её показывать.
 */
export function corridorsOf(draft: ContentSnapshot, base: ContentSnapshot, drafts: SideRuns | null, bases: SideRuns | null): CorridorReport[] {
  const draftBounds = corridorBounds(draft);
  const baseBounds = corridorBounds(base);
  return (Object.keys(CORRIDOR_TITLES) as CorridorId[]).map((id) => ({
    id,
    title: CORRIDOR_TITLES[id],
    corridor: draftBounds[id],
    baseCorridor: baseBounds[id],
    draft: side(drafts, draft, id),
    base: side(bases, base, id),
  }));
}
