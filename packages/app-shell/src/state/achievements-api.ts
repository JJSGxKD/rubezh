import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";

/**
 * Витрина достижений с сервера (docs/39-retention-mechanics.md К1,
 * tasks/T-0106, T-0107): список с категориями, лестницами, редкостью и
 * престижем, сводка для профиля и три любимых. Прогресс и награду считает и
 * выдаёт сервер; забор — прежним `POST /tasks/:id/claim` (`tasks-api.ts`).
 *
 * Категория и вид цели — строками, а не перечислением: сервер новее клиента
 * может завести то, чего клиент не знает, и витрина нарисует это, а не упадёт.
 *
 * Закрытое скрытое достижение приходит отдельной веткой: сервер не отдаёт ни
 * названия, ни цели, ни награды того, что игрок ещё не открыл.
 */

const rewardSchema = z.object({ coins: z.number(), gems: z.number(), shards: z.number() });

const openSchema = z.object({
  id: z.string(),
  category: z.string(),
  /** общая лестница и номер ступени; у одиночного достижения `null` или поля нет */
  ladder: z.optional(z.nullable(z.string())),
  rung: z.optional(z.nullable(z.number())),
  hidden: z.boolean(),
  kind: z.string(),
  /** оружие, стихия или сложность цели — по ним строится текст */
  filter: z.optional(z.nullable(z.object({ weapon: z.optional(z.string()), element: z.optional(z.string()), difficulty: z.optional(z.string()) }))),
  title: z.nullable(z.string()),
  hint: z.optional(z.nullable(z.string())),
  target: z.number(),
  value: z.number(),
  done: z.boolean(),
  claimed: z.boolean(),
  reward: rewardSchema,
  prestige: z.number(),
  /** «есть у N%»; `null` или нет поля — населения мало, строки редкости нет */
  percent: z.optional(z.nullable(z.number())),
});

const closedSchema = z.object({ id: z.string(), category: z.string(), hidden: z.literal(true), done: z.literal(false), hint: z.string() });

const viewSchema = z.object({
  prestige: z.number(),
  /** id любимых в порядке слотов */
  favorites: z.array(z.string()),
  rarity: z.object({ population: z.number(), shown: z.boolean(), computedAt: z.nullable(z.string()) }),
  items: z.array(z.union([openSchema, closedSchema])),
});

const summarySchema = z.object({
  prestige: z.number(),
  favorites: z.array(z.object({ id: z.string(), title: z.nullable(z.string()), category: z.string() })),
});

const favoritesSchema = z.object({ favorites: z.array(z.string()) });

export type OpenAchievement = z.infer<typeof openSchema>;
export type ClosedAchievement = z.infer<typeof closedSchema>;
export type AchievementItem = OpenAchievement | ClosedAchievement;
export type AchievementsView = z.infer<typeof viewSchema>;
export type AchievementsSummary = z.infer<typeof summarySchema>;

/** Открытая строка — с названием, целью и наградой; закрытое скрытое — только подсказка. */
export function isOpenAchievement(item: AchievementItem): item is OpenAchievement {
  return "kind" in item;
}

/** В любимые ставят только полученное: сервер отказывает по остальному одним кодом. */
export const ACHIEVEMENT_NOT_UNLOCKED = "achievement_not_unlocked";

/** Текст отказа сохранить любимые по коду сервера — ключом словаря. */
export function favoriteFailureKey(code: string | undefined): string {
  return code === ACHIEVEMENT_NOT_UNLOCKED ? "achievements.favorite.locked" : "achievements.favoriteFailed";
}

export interface AchievementsApi {
  load(): Promise<ApiResult<AchievementsView>>;
  /** престиж и любимые для профиля, без списка */
  summary(): Promise<ApiResult<AchievementsSummary>>;
  /** заменить любимые: порядок `ids` — порядок слотов */
  setFavorites(ids: readonly string[]): Promise<ApiResult<{ favorites: string[] }>>;
}

const PREFIX = "/api/v1/achievements";

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createAchievementsApi(request: ApiRequest = apiRequest): AchievementsApi {
  return {
    load: () => request(PREFIX, viewSchema, { method: "GET" }),
    summary: () => request(`${PREFIX}/summary`, summarySchema, { method: "GET" }),
    setFavorites: (ids) => request(`${PREFIX}/favorites`, favoritesSchema, { method: "PUT", body: { ids: [...ids] } }),
  };
}
