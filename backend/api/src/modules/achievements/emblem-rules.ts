import { z } from "zod";
import type { AchievementCategory, EmblemTier, TaskDef } from "../tasks/task-rules.js";

/**
 * Знаки у имени, правила без базы (docs/35-stage4-plan.md Р149, tasks/T-0235):
 * кто какой знак держит, какой из них показывается в списках и как строка
 * каталога становится знаком. Запросы — `emblems.repository.ts`, сборка —
 * `emblems.service.ts`.
 *
 * Знак — это достижение, которое носят. Статусные и сезонные знаки — строки того
 * же каталога без прогресса: держит ли их игрок, считается при чтении по
 * состоянию аккаунта, поэтому истёкший VIP ничего не снимает.
 */

export const EMBLEM_IDS = {
  vip: "emb_vip",
  tester: "emb_tester",
  supporter: "emb_supporter",
  team: "emb_team",
  seasonChampion: "emb_season_champion",
  seasonTop10: "emb_season_top10",
  seasonTop100: "emb_season_top100",
} as const;

/**
 * Знак по умолчанию, пока игрок ничего не выбрал или выбранное больше не держится:
 * первый из статусных, которые он держит, в этом порядке. Сезонные и заслуги сами не
 * показываются — их носят по выбору.
 */
export const STATUS_ORDER = [EMBLEM_IDS.team, EMBLEM_IDS.vip, EMBLEM_IDS.supporter, EMBLEM_IDS.tester] as const;

/** Сезонные знаки по порогу лучшего места, от старшего: место не больше `maxPlace` — знак держится. */
export const SEASON_STEPS = [
  { id: EMBLEM_IDS.seasonChampion, maxPlace: 1 },
  { id: EMBLEM_IDS.seasonTop10, maxPlace: 10 },
  { id: EMBLEM_IDS.seasonTop100, maxPlace: 100 },
] as const;

/**
 * Роли, которые пускают в панель, но не делают человека членом команды игры. «Команду» ставят
 * тем, кто работает над игрой; внешний партнёр с кабинетом (T-0217) ею не станет.
 */
export const EXTERNAL_ROLES: readonly string[] = ["partner"];

/** Название закрытого скрытого знака: настоящее игрок узнает, только получив его. */
export const HIDDEN_EMBLEM_TITLE = "Скрытый знак";

/** Что сервер знает об аккаунте, чтобы решить, какие статусные знаки он держит. */
export interface StatusState {
  vipActive: boolean;
  testerAt: Date | null;
  supporterAt: Date | null;
  /** есть хоть одна роль команды */
  hasRole: boolean;
}

/**
 * VIP идёт, пока конец последнего периода позже момента. Правило то же, что у
 * `VipService.activeAt`: период, кончившийся ровно сейчас, уже не идёт.
 */
export function isVipActive(until: Date | null, at: Date): boolean {
  return until !== null && until.getTime() > at.getTime();
}

/** Статусные знаки, которые держит аккаунт. */
export function heldStatus(state: StatusState): Set<string> {
  const held = new Set<string>();
  if (state.hasRole) held.add(EMBLEM_IDS.team);
  if (state.vipActive) held.add(EMBLEM_IDS.vip);
  if (state.supporterAt !== null) held.add(EMBLEM_IDS.supporter);
  if (state.testerAt !== null) held.add(EMBLEM_IDS.tester);
  return held;
}

/**
 * Сезонные знаки по лучшему месту среди закрытых сезонов с достаточной таблицей. Места, которого
 * не бывает, знака не дают: данные базы читаются как есть, а не доверием к ним.
 */
export function heldSeason(bestPlace: number | null): Set<string> {
  const held = new Set<string>();
  if (bestPlace === null || !Number.isInteger(bestPlace) || bestPlace < 1) return held;
  for (const step of SEASON_STEPS) if (bestPlace <= step.maxPlace) held.add(step.id);
  return held;
}

/**
 * Знак, который показывается: выбранный, если он держится, иначе первый держимый из
 * `STATUS_ORDER`, иначе никакого.
 */
export function shownEmblem(chosen: string | null, held: ReadonlySet<string>): string | null {
  if (chosen !== null && held.has(chosen)) return chosen;
  return STATUS_ORDER.find((id) => held.has(id)) ?? null;
}

/** Группа знака для клиента: статус и сезон — свои, любая другая категория достижений — заслуги. */
export type EmblemGroup = "status" | "season" | "merit";

export function emblemGroupOf(category: AchievementCategory | null): EmblemGroup {
  return category === "status" || category === "season" ? category : "merit";
}

/** Строка каталога, из которой делается знак: у неё есть редкость и название. */
export interface EmblemDef {
  taskId: string;
  title: string;
  category: AchievementCategory | null;
  emblemTier: EmblemTier;
}

/** Знак каталога: редкость задана и название не пустое. Безымянный знак в списках нечем показать. */
export function isEmblemDef<T extends Pick<TaskDef, "title" | "emblemTier">>(def: T): def is T & { title: string; emblemTier: EmblemTier } {
  return def.emblemTier !== null && def.title !== null;
}

/** Знак у имени в строке списка. */
export interface PublicEmblem {
  id: string;
  title: string;
  tier: EmblemTier;
  category: EmblemGroup;
  /** порядковый номер сезона — только у сезонного знака */
  season?: number;
}

/** То, что список показывает рядом с именем игрока; облик (T-0237) добавится сюда же. */
export interface PublicMark {
  emblem?: PublicEmblem;
}

/** Знак для строки списка. Номер сезона кладётся только сезонному знаку. */
export function publicEmblemOf(def: EmblemDef, season: number | null): PublicEmblem {
  const category = emblemGroupOf(def.category);
  return { id: def.taskId, title: def.title, tier: def.emblemTier, category, ...(category === "season" && season !== null ? { season } : {}) };
}

/** Строка раздела «Знаки»: все знаки каталога, и держимые, и закрытые. */
export interface EmblemItem {
  id: string;
  title: string;
  /** условие получения; у обычных достижений его может не быть */
  hint: string | null;
  category: EmblemGroup;
  tier: EmblemTier;
  held: boolean;
  season?: number;
  /** «есть у N%»; `null` — население ниже порога, пересчёта не было или знак скрыт */
  percent: number | null;
}

export interface EmblemsView {
  /** id знака, который сейчас у имени; `null` — знака нет */
  shown: string | null;
  /** `true` — игрок ничего не выбрал или выбранное не держится: знак выбран самим сервером */
  auto: boolean;
  items: EmblemItem[];
}

/**
 * Строка раздела. Закрытое скрытое достижение не выдаёт названия и процента — только условие:
 * иначе знак выдал бы то, что витрина достижений прячет.
 */
export function emblemItemOf(def: EmblemDef & { hint: string | null; hidden: boolean }, held: boolean, season: number | null, percent: number | null): EmblemItem {
  const closedHidden = def.hidden && !held;
  const category = emblemGroupOf(def.category);
  return {
    id: def.taskId,
    title: closedHidden ? HIDDEN_EMBLEM_TITLE : def.title,
    hint: def.hint,
    category,
    tier: def.emblemTier,
    held,
    ...(category === "season" && season !== null ? { season } : {}),
    percent: closedHidden ? null : percent,
  };
}

/** Тело `PUT /achievements/emblem`: id знака или `null` — вернуть «по умолчанию». */
export const emblemChoiceSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,47}$/)
      .nullable(),
  })
  .strict();
