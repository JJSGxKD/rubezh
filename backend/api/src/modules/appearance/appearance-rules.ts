import { z } from "zod";
import { APPEARANCES, DEFAULT_APPEARANCE, appearanceById, type AppearanceArchetype, type AppearanceDef, type AppearanceRarity, type AppearanceSource } from "./appearance-catalog.js";

/**
 * Облики, правила без базы (docs/35-stage4-plan.md Р150, tasks/T-0237): какими обликами
 * владеет игрок и какой из них действует. Владение вычисляется при чтении по состоянию
 * аккаунта: истёкший VIP Князя не снимает, а вернувшийся возвращает. Хранится только то, что
 * состоянием не вычислить, — облик, выданный разово (`appearance_grant`, tasks/T-0245).
 */

/** Что сервер знает об аккаунте, чтобы решить, какими обликами он владеет. */
export interface AppearanceState {
  /** уровень аккаунта; аккаунта без прогресса нет в базе — уровень 1 */
  level: number;
  vipActive: boolean;
  /** лучшее место среди недельных сезонов с достаточной таблицей; `null` — в таблицу не попадал */
  bestSeasonPlace: number | null;
  /** id выполненных достижений из тех, что дают облик */
  doneAchievements: ReadonlySet<string>;
  /** хоть раз забрана верхняя ступень очков недели */
  weeklyTopClaimed: boolean;
  /** облики, выданные разово (`appearance_grant`): считаются только у обликов с источником «покупка» */
  grants: ReadonlySet<string>;
}

/** Облики, которыми владеет аккаунт. */
export function heldAppearances(state: AppearanceState): Set<string> {
  const held = new Set<string>();
  for (const def of APPEARANCES) if (isHeld(def, state)) held.add(def.id);
  return held;
}

function isHeld(def: AppearanceDef, state: AppearanceState): boolean {
  const { source } = def;
  switch (source.kind) {
    case "start":
      return true;
    case "level":
      return state.level >= source.level;
    case "weekly_points":
      return state.weeklyTopClaimed;
    case "achievement":
      return state.doneAchievements.has(source.achievementId);
    case "event":
      // Выдача разовая и придёт с Ярмаркой (Р154) отдельным источником; пока облика не получить.
      return false;
    case "vip":
      return state.vipActive;
    case "purchase":
      // Только строка выдачи: чужая строка с id облика другого источника (Князь, Навий страж) его не даёт.
      return state.grants.has(def.id);
    case "season": {
      // Места, которого не бывает, облик не даёт: данные базы читаются как есть, а не доверием к ним.
      const place = state.bestSeasonPlace;
      return place !== null && Number.isInteger(place) && place >= 1 && place <= source.maxPlace;
    }
  }
}

/**
 * Облик, который виден в ответах: выбранный, если им владеют, иначе Хранитель. Выбор при этом
 * не стирается — вернулось владение, вернулся и облик.
 */
export function effectiveAppearance(selected: string | null | undefined, held: ReadonlySet<string>): string {
  if (selected === null || selected === undefined) return DEFAULT_APPEARANCE;
  return appearanceById(selected) !== undefined && held.has(selected) ? selected : DEFAULT_APPEARANCE;
}

/** Выбор игрока: облик, кружок аватара или оба; пустое тело — ошибка. */
export const appearanceChoiceSchema = z
  .object({ id: z.string().min(1).max(24).optional(), avatarPhoto: z.boolean().optional() })
  .refine((body) => body.id !== undefined || body.avatarPhoto !== undefined, { message: "Нужен облик или выбор аватара" });

export type AppearanceChoiceInput = z.infer<typeof appearanceChoiceSchema>;

/** Источник облика в ответе: у достижения — ещё название из каталога заданий. */
export type AppearanceSourceView = AppearanceSource & { title?: string };

export interface AppearanceItemView {
  id: string;
  archetype: AppearanceArchetype;
  rarity: AppearanceRarity;
  held: boolean;
  source: AppearanceSourceView;
}

/** Раздел «Облики» игрока: каталог с отметкой «держит» и выбор. */
export interface AppearanceView {
  /** сохранённый выбор; не выбирал — `keeper` */
  selected: string;
  /** облик, который действует сейчас: выбранный, если им владеют, иначе `keeper` */
  effective: string;
  /** в кружке аватара фото площадки, а не голова облика */
  avatarPhoto: boolean;
  items: AppearanceItemView[];
}

/** Ответ на выбор: то же, что в шапке раздела. */
export type AppearanceChoice = Pick<AppearanceView, "selected" | "effective" | "avatarPhoto">;
