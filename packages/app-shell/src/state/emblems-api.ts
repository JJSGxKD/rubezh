import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";

/**
 * Знаки у имени с сервера (docs/35-stage4-plan.md Р149, tasks/T-0235,
 * tasks/T-0236): раздел «Знаки» — все знаки каталога с отметкой «держит» — и
 * выбор знака, который носится у имени. Что держит игрок и какой знак
 * показывается по умолчанию, решает сервер; клиент показывает и просит.
 *
 * Категория и редкость в разделе — строками, а не перечислением: сервер новее
 * клиента может завести то, чего клиент не знает, и раздел нарисует это как
 * «заслугу» обычной редкости, а не упадёт.
 */

export { publicEmblemSchema, type PublicEmblemView } from "./public-emblem";

const itemSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** условие получения; у закрытого скрытого — только оно */
  hint: z.optional(z.nullable(z.string())),
  category: z.string(),
  tier: z.string(),
  held: z.boolean(),
  season: z.optional(z.number()),
  /** «есть у N%»; `null` или нет поля — населения мало или знак скрыт */
  percent: z.optional(z.nullable(z.number())),
});

const viewSchema = z.object({
  /** id знака у имени; `null` — знака нет */
  shown: z.nullable(z.string()),
  /** `true` — знак выбрал сервер: игрок ничего не выбирал или выбранное не держится */
  auto: z.boolean(),
  items: z.array(itemSchema),
});

const choiceSchema = z.object({ shown: z.nullable(z.string()), auto: z.boolean() });

export type EmblemItem = z.infer<typeof itemSchema>;
export type EmblemsView = z.infer<typeof viewSchema>;
export type EmblemChoice = z.infer<typeof choiceSchema>;

/** Выбрать можно только полученный знак (409) и только тот, что есть в каталоге (404). */
export const EMBLEM_NOT_HELD = "emblem_not_held";
export const EMBLEM_NOT_FOUND = "emblem_not_found";

/**
 * Что делать экрану с отказом выбрать знак. Оба кода значат, что состояние на
 * экране разошлось с сервером (знак пропал из каталога, VIP кончился), — раздел
 * перечитывается; игроку на любой отказ говорится одно.
 */
export function emblemFailure(code: string | undefined): { textKey: string; reload: boolean } {
  return { textKey: "emblems.chooseFailed", reload: code === EMBLEM_NOT_HELD || code === EMBLEM_NOT_FOUND };
}

export interface EmblemsApi {
  load(): Promise<ApiResult<EmblemsView>>;
  /** выбрать знак; `null` возвращает «по умолчанию» */
  choose(id: string | null): Promise<ApiResult<EmblemChoice>>;
}

const PREFIX = "/api/v1/achievements";

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createEmblemsApi(request: ApiRequest = apiRequest): EmblemsApi {
  return {
    load: () => request(`${PREFIX}/emblems`, viewSchema, { method: "GET" }),
    choose: (id) => request(`${PREFIX}/emblem`, choiceSchema, { method: "PUT", body: { id } }),
  };
}
