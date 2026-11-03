import { z } from "zod";
import type { AchievementCategory, RunFilter, TaskDef, TaskKind } from "../tasks/task-rules.js";

/**
 * Достижения с престижем (docs/39-retention-mechanics.md К1, tasks/T-0106):
 * правила, которые не зависят от базы, — процент «есть у N%», срок пересчёта
 * редкости, схема избранного и форма строки витрины.
 *
 * Определения живут в каталоге заданий (`task_def`, период `achievement`): забег,
 * защита от повтора, забор и потолок кошелька работают на нём. Здесь — только
 * то, что добавляет витрина.
 */

/** Сколько любимых достижений у игрока: столько слотов в профиле. */
export const FAVORITES_MAX = 3;

const TASK_ID = /^[a-z][a-z0-9_]{1,47}$/;

/** Тело `PUT /achievements/favorites`: порядок массива — порядок слотов, пустой список очищает. */
export const favoritesSchema = z
  .object({
    ids: z
      .array(z.string().regex(TASK_ID))
      .max(FAVORITES_MAX)
      .refine((ids) => new Set(ids).size === ids.length, { message: "id не повторяются" }),
  })
  .strict();

/** Ключ лока пересчёта редкости в Redis: пересчитывает одна реплика за раз. */
export const RARITY_LOCK_KEY = "achievements:rarity:lock";

/** Срок лока: дольше худшего прохода (запрос ограничен `RARITY_QUERY_TIMEOUT_MS`), короче пустого ожидания. */
export const RARITY_LOCK_TTL_MS = 5 * 60_000;

/** Как часто задача просыпается посмотреть, не пора ли пересчитывать; сам период — настройка. */
export const RARITY_TICK_MS = 10 * 60_000;

/** Потолок запроса пересчёта: он идёт по всем игрокам с забегом и по всем выполненным достижениям. */
export const RARITY_QUERY_TIMEOUT_MS = 60_000;

/**
 * Сколько процентов игроков выполнили достижение. Население меньше порога —
 * `null`: у трёх игроков не должно быть «100%». Держателей не больше населения
 * (пересчёт читает таблицы не одним снимком), поэтому потолок — сто.
 */
export function percentOf(holders: number, population: number, minPlayers: number): number | null {
  if (population <= 0 || population < minPlayers) return null;
  return Math.min(100, Math.round((Math.max(0, holders) / population) * 1000) / 10);
}

/**
 * Пора ли пересчитывать редкость: таблица пуста или последний пересчёт старше
 * периода. Часы, ушедшие назад, пересчёт не запускают — иначе он шёл бы каждый тик.
 */
export function rarityDue(computedAt: Date | null, now: Date, refreshMin: number): boolean {
  if (computedAt === null) return true;
  return now.getTime() - computedAt.getTime() >= refreshMin * 60_000;
}

/** Прогресс игрока по достижению: то, что лежит в `task_progress`. */
export interface ProgressCell {
  value: number;
  done: boolean;
  claimed: boolean;
}

/** Закрытое скрытое: ни названия, ни вида, ни цели, ни награды — только подсказка. */
export interface ClosedAchievement {
  id: string;
  category: AchievementCategory;
  hidden: true;
  done: false;
  hint: string;
}

export interface OpenAchievement {
  id: string;
  category: AchievementCategory;
  ladder: string | null;
  rung: number | null;
  hidden: boolean;
  kind: TaskKind;
  /** оружие, стихия или сложность цели — по ним клиент строит текст */
  filter: RunFilter | null;
  /** `null` — название не задано, текст по виду цели у клиента */
  title: string | null;
  hint: string | null;
  target: number;
  value: number;
  done: boolean;
  claimed: boolean;
  reward: { coins: number; gems: number; shards: number };
  prestige: number;
  /** «есть у N%»; `null` — население ниже порога или пересчёта ещё не было */
  percent: number | null;
}

export type AchievementItem = ClosedAchievement | OpenAchievement;

export interface AchievementsView {
  prestige: number;
  /** id любимых достижений в порядке слотов */
  favorites: string[];
  rarity: {
    /** сколько игроков в знаменателе; 0 — пересчёта ещё не было */
    population: number;
    /** хватает ли населения для процента: иначе у всех строк `percent: null` */
    shown: boolean;
    computedAt: string | null;
  };
  items: AchievementItem[];
}

export interface FavoriteSummary {
  id: string;
  title: string | null;
  category: AchievementCategory;
}

/** Профиль: сумма престижа и три любимых — без списка достижений. */
export interface AchievementsSummary {
  prestige: number;
  favorites: FavoriteSummary[];
}

function categoryOf(def: TaskDef): AchievementCategory {
  // Витрина берёт только достижения с категорией; пустая здесь — ошибка вызывающего, а не данные.
  if (def.category === null) throw new Error(`у достижения ${def.taskId} нет категории`);
  return def.category;
}

/**
 * Строка витрины. Закрытое скрытое отдаёт только `id`, категорию, признак,
 * `done: false` и подсказку: сервер не показывает то, чего игрок ещё не открыл,
 * а не прячет это на клиенте.
 */
export function itemOf(def: TaskDef, cell: ProgressCell | undefined, percent: number | null): AchievementItem {
  const category = categoryOf(def);
  const done = cell?.done ?? false;
  if (def.hidden && !done) return { id: def.taskId, category, hidden: true, done: false, hint: def.hint ?? "" };
  return {
    id: def.taskId,
    category,
    ladder: def.ladder,
    rung: def.rung,
    hidden: def.hidden,
    kind: def.kind,
    filter: def.filter,
    title: def.title,
    hint: def.hint,
    target: def.target,
    value: Math.min(cell?.value ?? 0, def.target),
    done,
    claimed: cell?.claimed ?? false,
    reward: { coins: def.coins, gems: def.gems, shards: def.shards },
    prestige: def.prestige,
    percent,
  };
}

export function summaryItemOf(def: TaskDef): FavoriteSummary {
  return { id: def.taskId, title: def.title, category: categoryOf(def) };
}
