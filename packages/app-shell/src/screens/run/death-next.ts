import { RUBEZH_AT_SEC, type RunRubezh } from "@bh/shared-types";
import { formatDuration, t } from "../../i18n";
import { unlockLabel, type LevelUnlock } from "../../state/level-unlocks";
import type { RunRewardView } from "../../state/progress";
import { levelBar } from "./death-rules";

/**
 * «Что дальше» на экране смерти (tasks/T-0109): две-три ближайшие цели под
 * наградой — до рекорда, до уровня, задание на подходе, ближайшее открытие.
 * Решение «уйти или сыграть ещё» принимается здесь, а игрок не видит, что до
 * рекорда не хватило сорока секунд. Блок подсказка, а не расчёт: если
 * прогресс задания ещё не дошёл до сервера, цель появится на следующем забеге.
 *
 * Только чистые функции — запросы и рисование в `DeathNext.tsx`.
 */

/** Сколько целей показывать: больше трёх — список, который не читают. */
export const MAX_GOALS = 3;

/** Рекорд — цель, если забег не короче его половины: до «почти» дотягиваются, до «вдвое меньше» — нет. */
export const RECORD_CLOSE = 0.5;

/**
 * Рубеж — цель, если забег дожил не меньше чем до половины отметки стража: до
 * «почти» дотягиваются, а с трети пути «до рубежа ещё 400 с» не мотивирует,
 * а отпугивает. Число стартовое, калибрует геймдизайнер.
 */
export const RUBEZH_CLOSE = 0.5;

/** Уровень — цель, если пройдено не меньше 40% полосы: свежая полоса «до уровня» ещё не мотивирует. */
export const LEVEL_CLOSE = 0.4;

/** Задание — цель, если выполнено не меньше половины. */
export const TASK_CLOSE = 0.5;

/** Близость цели «открытие»: ниже порогов остальных целей, поэтому она ставится после них, но берётся, когда они не набрались. */
export const UNLOCK_CLOSENESS = 0.3;

/** Виды цели задания, которые двигает сам забег: подписки, ссылки и достижения сюда не входят. */
const RUN_TASK_KINDS: readonly string[] = ["runs", "kills", "survive_sec", "best_survival_sec", "run_level"];

export type NextGoal =
  | { kind: "record"; closeness: number; gapSec: number; bestSec: number }
  | { kind: "rubezh"; stage: "approach"; closeness: number; leftSec: number }
  | { kind: "rubezh"; stage: "guard"; closeness: number; guardHpPercent: number }
  | { kind: "level"; closeness: number; level: number; xpLeft: number; unlocks: LevelUnlock[] }
  | { kind: "task"; closeness: number; period: "daily" | "weekly"; value: number; target: number }
  | { kind: "unlock"; closeness: number; level: number; unlocks: LevelUnlock[] };

export interface NextGoalsInput {
  isNewRecord: boolean;
  survivalSec: number;
  /** рекорд на сложности забега с учётом этого забега; `null` — неизвестен */
  bestSec: number | null;
  /** после забега: уровень аккаунта, доля его полосы и остаток опыта; `null` — награды нет или высший уровень */
  level: { level: number; fraction: number; xpLeft: number } | null;
  tasks: readonly { id: string; period: string; kind: string; value: number; target: number; done: boolean }[];
  nextUnlock: { level: number; unlocks: LevelUnlock[] } | null;
  /** рубеж забега; нет — итог сборки до рубежа, цели «рубеж» тогда считаются по секундам */
  rubezh?: RunRubezh | undefined;
}

/** При равной близости раньше то, что игрок может сделать прямо сейчас: рекорд, рубеж, задание, потом уровень и открытие. */
const KIND_ORDER: Record<NextGoal["kind"], number> = { record: 0, rubezh: 1, task: 2, level: 3, unlock: 4 };

function recordGoal(input: NextGoalsInput): NextGoal | null {
  const { bestSec, survivalSec } = input;
  // У нового рекорда своя плашка в шапке.
  if (input.isNewRecord || bestSec === null || bestSec <= 0 || survivalSec >= bestSec) return null;
  const closeness = survivalSec / bestSec;
  return closeness < RECORD_CLOSE ? null : { kind: "record", closeness, gapSec: bestSec - survivalSec, bestSec };
}

/**
 * Рубеж (T-0124): до прихода стража — секунды до отметки, после — остаток его
 * здоровья. Победа цели не оставляет. Близость стража считается от половины:
 * дожить до него уже полпути, дальше растёт с тем, сколько здоровья снято.
 */
function rubezhGoal(input: NextGoalsInput): NextGoal | null {
  const rubezh = input.rubezh;
  if (rubezh !== undefined && rubezh.clearedSec !== null) return null;
  if (rubezh?.reached === true) {
    // Остатка нет — говорить «почти пал» нечем.
    if (rubezh.guardHpPercent === null) return null;
    const closeness = 0.5 + 0.5 * (1 - rubezh.guardHpPercent / 100);
    return { kind: "rubezh", stage: "guard", closeness, guardHpPercent: rubezh.guardHpPercent };
  }
  const { survivalSec } = input;
  // Дожил до отметки, а страж не пришёл (итог без поля или без стража): считать нечего.
  if (survivalSec >= RUBEZH_AT_SEC) return null;
  const closeness = survivalSec / RUBEZH_AT_SEC;
  if (closeness < RUBEZH_CLOSE) return null;
  return { kind: "rubezh", stage: "approach", closeness, leftSec: Math.ceil(RUBEZH_AT_SEC - survivalSec) };
}

/** Из заданий дня и недели — одно, с большей долей; при равенстве ежедневное раньше недельного, дальше меньший id. */
function taskGoal(input: NextGoalsInput): NextGoal | null {
  let best: { period: "daily" | "weekly"; id: string; value: number; target: number; closeness: number } | null = null;
  for (const task of input.tasks) {
    const period: "daily" | "weekly" | null = task.period === "daily" ? "daily" : task.period === "weekly" ? "weekly" : null;
    if (task.done || period === null || !RUN_TASK_KINDS.includes(task.kind)) continue;
    // Нулевая цель — деление на ноль: такое задание пропускаем.
    if (!(task.target > 0)) continue;
    const closeness = task.value / task.target;
    if (closeness < TASK_CLOSE) continue;
    const candidate = { period, id: task.id, value: task.value, target: task.target, closeness };
    if (best === null || beats(candidate, best)) best = candidate;
  }
  return best === null ? null : { kind: "task", closeness: best.closeness, period: best.period, value: best.value, target: best.target };
}

function beats(a: { period: "daily" | "weekly"; id: string; closeness: number }, b: { period: "daily" | "weekly"; id: string; closeness: number }): boolean {
  if (a.closeness !== b.closeness) return a.closeness > b.closeness;
  if (a.period !== b.period) return a.period === "daily";
  return a.id < b.id;
}

export function pickNextGoals(input: NextGoalsInput): NextGoal[] {
  const goals: NextGoal[] = [];
  const record = recordGoal(input);
  if (record !== null) goals.push(record);
  const rubezh = rubezhGoal(input);
  if (rubezh !== null) goals.push(rubezh);
  const task = taskGoal(input);
  if (task !== null) goals.push(task);

  let unlock = input.nextUnlock;
  if (input.level !== null && input.level.fraction >= LEVEL_CLOSE) {
    const reaches = input.level.level + 1;
    // Открытие ровно на следующем уровне — подпись к цели уровня, а не вторая строка.
    const merged = unlock !== null && unlock.level === reaches ? unlock : null;
    goals.push({ kind: "level", closeness: input.level.fraction, level: reaches, xpLeft: input.level.xpLeft, unlocks: merged?.unlocks ?? [] });
    if (merged !== null) unlock = null;
  }
  if (unlock !== null) goals.push({ kind: "unlock", closeness: UNLOCK_CLOSENESS, level: unlock.level, unlocks: unlock.unlocks });

  return goals.sort((a, b) => b.closeness - a.closeness || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]).slice(0, MAX_GOALS);
}

export function goalText(goal: NextGoal): string {
  switch (goal.kind) {
    case "record":
      return t("run.next.record", { gap: formatDuration(goal.gapSec), best: formatDuration(goal.bestSec) });
    case "rubezh":
      return goal.stage === "approach"
        ? t("run.next.rubezh", { sec: goal.leftSec })
        : t("run.next.rubezh.guard", { percent: goal.guardHpPercent });
    case "task":
      return t(goal.period === "daily" ? "run.next.task.daily" : "run.next.task.weekly", { value: goal.value, target: goal.target });
    case "level":
      return goal.unlocks.length === 0
        ? t("run.next.level", { level: goal.level, xp: goal.xpLeft })
        : t("run.next.level.unlock", { level: goal.level, xp: goal.xpLeft, list: goal.unlocks.map(unlockLabel).join(", ") });
    case "unlock":
      return t("run.next.unlock", { level: goal.level, list: goal.unlocks.map(unlockLabel).join(", ") });
  }
}

/** Награда за забег — в то, что нужно цели «уровень»; `null` — награды нет (считается, гость) или высший уровень. */
export function levelGoalInput(reward: RunRewardView | undefined): NextGoalsInput["level"] {
  if (reward === undefined || reward.status !== "granted") return null;
  const bar = levelBar(reward);
  return bar.toNext === null ? null : { level: bar.level, fraction: bar.after, xpLeft: bar.toNext };
}
