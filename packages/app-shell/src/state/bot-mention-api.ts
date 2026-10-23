import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";

/**
 * Задания «юзернейм бота в имени и в bio» (docs/35-stage4-plan.md Р110,
 * tasks/T-0160): проверку и награду ведёт сервер, клиент ничего не считает —
 * ни награду, ни серию, ни «стоит или нет». Он показывает ответ и присылает
 * один вид задания.
 *
 * Модуль грузится вместе с экраном заданий — первой загрузке он не нужен.
 *
 * Вид и исход — строкой, а не перечислением: сервер новее клиента может завести
 * то, чего клиент ещё не знает, и это не должно ронять экран (как `tasks-api.ts`).
 */

const rewardSchema = z.object({ coins: z.number(), gems: z.number(), shards: z.number() });

const taskSchema = z.object({
  /** `name` или `bio`; незнакомый вид блок молча пропускает */
  kind: z.string(),
  reward: rewardSchema,
  started: z.boolean(),
  /** сколько игровых суток подряд была награда */
  streak: z.number(),
  bestStreak: z.number(),
  rewardedToday: z.boolean(),
  lastResult: z.nullable(z.string()),
  checkedAt: z.nullable(z.string()),
});

const viewSchema = z.object({
  /** что вписать, без «@»; `null` — у этой площадки заданий нет */
  botUsername: z.nullable(z.string()),
  tasks: z.array(taskSchema),
});

const checkSchema = z.object({
  outcome: z.string(),
  /** сколько легло сейчас; нули — не начислялось */
  credited: rewardSchema,
  view: viewSchema,
});

export type BotMentionTask = z.infer<typeof taskSchema>;
export type BotMentionView = z.infer<typeof viewSchema>;
export type BotMentionCheck = z.infer<typeof checkSchema>;

export interface BotMentionApi {
  /** `GET /api/v1/bot-mention` */
  view(): Promise<ApiResult<BotMentionView>>;
  /** `POST /api/v1/bot-mention/<вид>/check` — без тела: исход и награду решает сервер */
  check(kind: string): Promise<ApiResult<BotMentionCheck>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createBotMentionApi(request: ApiRequest = apiRequest): BotMentionApi {
  return {
    view: () => request("/api/v1/bot-mention", viewSchema, { method: "GET" }),
    check: (kind) => request(`/api/v1/bot-mention/${encodeURIComponent(kind)}/check`, checkSchema, { method: "POST" }),
  };
}

/** Исходы, которые знает событие аналитики: незнакомый от сервера новее клиента в событие не идёт. */
export const BOT_MENTION_OUTCOMES = ["present", "absent", "hidden", "unavailable", "retry", "done_today"] as const;

export type BotMentionOutcome = (typeof BOT_MENTION_OUTCOMES)[number];

export function isKnownOutcome(outcome: string): outcome is BotMentionOutcome {
  return (BOT_MENTION_OUTCOMES as readonly string[]).includes(outcome);
}
