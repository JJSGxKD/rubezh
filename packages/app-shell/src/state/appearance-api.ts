import { useEffect } from "react";
import { create } from "zustand";
import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";

/**
 * Облики героя с сервера (docs/35-stage4-plan.md Р150, tasks/T-0237,
 * tasks/T-0238): раздел «Облик» — все облики каталога с отметкой «держит» и
 * источником — и выбор облика и кружка аватара. Чем владеет игрок и какой облик
 * действует, решает сервер; клиент показывает и просит.
 *
 * Архетип, редкость и вид источника — строками, а не перечислением: сервер
 * новее клиента может завести то, чего клиент не знает, и раздел нарисует это
 * как обычное, а не упадёт.
 */

const sourceSchema = z.object({
  kind: z.string(),
  level: z.optional(z.number()),
  maxPlace: z.optional(z.number()),
  achievementId: z.optional(z.string()),
  /** название достижения — только у источника-достижения */
  title: z.optional(z.string()),
});

const itemSchema = z.object({
  id: z.string(),
  archetype: z.string(),
  rarity: z.string(),
  held: z.boolean(),
  source: sourceSchema,
});

const choiceSchema = z.object({
  /** сохранённый выбор игрока */
  selected: z.string(),
  /** облик, который действует: выбранный, если им владеют, иначе Хранитель */
  effective: z.string(),
  /** в кружке аватара фото площадки, а не голова облика */
  avatarPhoto: z.boolean(),
});

const viewSchema = z.object({ ...choiceSchema.shape, items: z.array(itemSchema) });

export type AppearanceItem = z.infer<typeof itemSchema>;
export type AppearanceView = z.infer<typeof viewSchema>;
export type AppearanceChoice = z.infer<typeof choiceSchema>;

/** Выбрать можно только полученный облик (409) и только тот, что есть в каталоге (404). */
export const APPEARANCE_LOCKED = "appearance_locked";
export const APPEARANCE_NOT_FOUND = "appearance_not_found";

/**
 * Что делать экрану с отказом выбрать облик. Оба кода значат, что экран
 * разошёлся с сервером (облик пропал из каталога, VIP кончился), — раздел
 * перечитывается; игроку на любой отказ говорится одно.
 */
export function appearanceFailure(code: string | undefined): { textKey: string; reload: boolean } {
  return { textKey: "appearance.chooseFailed", reload: code === APPEARANCE_LOCKED || code === APPEARANCE_NOT_FOUND };
}

export interface AppearanceApi {
  load(): Promise<ApiResult<AppearanceView>>;
  /** выбрать облик и/или кружок аватара; хотя бы одно поле */
  choose(change: { id?: string; avatarPhoto?: boolean }): Promise<ApiResult<AppearanceChoice>>;
}

const PATH = "/api/v1/appearance";

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createAppearanceApi(request: ApiRequest = apiRequest): AppearanceApi {
  return {
    load: () => request(PATH, viewSchema, { method: "GET" }),
    choose: (change) => request(PATH, choiceSchema, { method: "PUT", body: change }),
  };
}

/**
 * Свой облик для арсенала, профиля и кружка: последнее, что знает клиент.
 * `null` — ещё не загружен (или игрок гость): экран рисует Хранителя.
 */
export interface OwnAppearanceState {
  own: { effective: string; avatarPhoto: boolean } | null;
}

export const useOwnAppearance = create<OwnAppearanceState>(() => ({ own: null }));

/** Запомнить ответ сервера: экран «Облик» зовёт после выбора, арсенал и профиль — после загрузки. */
export function rememberOwnAppearance(choice: Pick<AppearanceChoice, "effective" | "avatarPhoto">): void {
  useOwnAppearance.setState({ own: { effective: choice.effective, avatarPhoto: choice.avatarPhoto } });
}

/** Для тестов и смены аккаунта. */
export function resetOwnAppearance(): void {
  useOwnAppearance.setState({ own: null });
}

const ownApi = createAppearanceApi();

/**
 * Подгрузить свой облик, когда он нужен экрану: зрителю с артом и вошедшему
 * игроку. Сбой не показывается — экран рисует Хранителя, как до обликов.
 */
export function useLoadOwnAppearance(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void ownApi.load().then((response) => {
      if (alive && response.ok) rememberOwnAppearance(response.data);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
}
