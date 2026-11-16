import { z } from "zod/mini";
import { isPublicId, type CardFailureReason } from "../screens/meta/player-card-rules";
import { apiRequest, type ApiFailure, type ApiRequest } from "./api-request";
import { publicEmblemSchema } from "./public-emblem";

/**
 * Карточка игрока с сервера (docs/35-stage4-plan.md Р48, tasks/T-0247,
 * tasks/T-0248): `GET /api/v1/players/:publicId`. Игрока называет публичный id,
 * внутреннего id в запросе и ответе нет. Что и кому показать, решает сервер
 * (скрытая доска, блокировка — для карточки одно «не найден»); клиент
 * рисует ответ.
 *
 * Отношение и облик — строками, а не перечислениями: сервер новее клиента может
 * завести новое, и карточка нарисует его как обычное, а не откажет целиком.
 *
 * Модуль грузится вместе с листом карточки — первой загрузке он не нужен.
 */

const cardSchema = z.object({
  publicId: z.string(),
  name: z.string(),
  photoUrl: z.optional(z.string()),
  /** действующий облик героя */
  appearance: z.string(),
  /** в кружке фото площадки, а не голова облика */
  avatarPhoto: z.optional(z.literal(true)),
  /** знак у имени, как в строках списков */
  emblem: z.optional(publicEmblemSchema),
  /** `held` — сколько знаков держит, `top` — до пяти лучших по редкости */
  emblems: z.object({ held: z.number(), top: z.array(publicEmblemSchema) }),
  level: z.number(),
  /** мощь надетого снаряжения */
  power: z.number(),
  /** место на доске сезона глазами смотрящего; `null` — сезона или игрока в таблице нет */
  season: z.nullable(z.object({ place: z.number() })),
  stats: z.object({ runs: z.number(), totalKills: z.number(), bestSurvivalSec: z.number() }),
  /** очки престижа за достижения */
  prestige: z.number(),
  /** до трёх любимых достижений витрины */
  favorites: z.array(z.object({ id: z.string(), title: z.nullable(z.string()), category: z.string() })),
  /** `self`, `friend`, `outgoing`, `incoming`, `none` — строкой: незнакомое экран просто не рисует действием */
  relation: z.string(),
  /** VIP активен; нет поля — нет */
  vip: z.optional(z.literal(true)),
});

export type PlayerCardView = z.infer<typeof cardSchema>;

/** Код 404 карточки: игрока нет, заблокирован или скрыт доской — ответ не говорит, что именно. */
export const PLAYER_NOT_FOUND = "player_not_found";
/** Код 429: открывают карточки чаще, чем сервер пускает. */
export const PLAYER_RATE_LIMITED = "rate_limited";

export type PlayerCardResult = { ok: true; data: PlayerCardView } | { ok: false; reason: CardFailureReason };

export interface PlayerCardApi {
  load(publicId: string): Promise<PlayerCardResult>;
}

/**
 * Причина отказа запроса: код сервера, если он есть, иначе причина запроса как
 * есть. 404 без кода — не «игрок не найден»: так отвечает шлюз или сервер без
 * карточек, и игроку это «не получилось», а не «нет такого».
 */
function reasonOf(failure: ApiFailure, code: string | undefined): CardFailureReason {
  if (code === PLAYER_NOT_FOUND) return "not_found";
  if (code === PLAYER_RATE_LIMITED) return "too_often";
  return failure;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createPlayerCardApi(request: ApiRequest = apiRequest): PlayerCardApi {
  return {
    load: async (publicId) => {
      // Не публичный id в путь не пускаем: чужая строка меняла бы адрес запроса.
      if (!isPublicId(publicId)) return { ok: false, reason: "not_found" };
      const response = await request(`/api/v1/players/${encodeURIComponent(publicId)}`, cardSchema, { method: "GET" });
      return response.ok ? response : { ok: false, reason: reasonOf(response.failure, response.code) };
    },
  };
}
