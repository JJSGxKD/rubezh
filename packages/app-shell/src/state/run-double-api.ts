import { z } from "zod/mini";
import type { AdWatchResult } from "./ad-watch";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { RESTRICTED_CODE } from "./restrictions";

/**
 * Удвоение монет за забег за рекламу (docs/35-stage4-plan.md WP12): кнопка
 * экрана итогов, а не запас на потом — сервер держит её час после забега, и
 * удвоить можно один раз. Удваиваются монеты, что легли в кошелёк; опыт —
 * нет. Кулдаун между удвоениями — у места рекламы.
 *
 * Модуль грузится с экраном смерти — первой загрузке он не нужен. Причина
 * отказа — строкой: сервер новее клиента может завести новую.
 */

const adSchema = z.object({ available: z.boolean(), readyAt: z.nullable(z.string()), pass: z.nullable(z.string()) });
const viewSchema = z.union([
  z.object({ status: z.literal("available"), coins: z.number(), until: z.string(), ad: adSchema }),
  z.object({ status: z.literal("doubled"), coins: z.number() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
/** `credited` — сколько легло: меньше `coins`, если упёрлось в суточный потолок наград за рекламу. */
const resultSchema = z.object({ credited: z.number(), coins: z.number() });

export type RunDoubleView = z.infer<typeof viewSchema>;
export type RunDoubleResult = z.infer<typeof resultSchema>;

/** Забег уже удвоен — с другой вкладки или до обрыва связи. */
export const RUN_ALREADY_DOUBLED = "run_already_doubled";
/** Удвоить нельзя: окно после забега прошло или награды нет. */
export const RUN_DOUBLE_UNAVAILABLE = "run_double_unavailable";
/** Место рекламы отдыхает — экран устарел. */
export const RUN_DOUBLE_COOLDOWN = "ad_cooldown";

export interface RunDoubleApi {
  view(runId: string): Promise<ApiResult<RunDoubleView>>;
  double(runId: string, sessionId: string): Promise<ApiResult<RunDoubleResult>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createRunDoubleApi(request: ApiRequest = apiRequest): RunDoubleApi {
  const path = (runId: string) => `/api/v1/progress/runs/${encodeURIComponent(runId)}/double`;
  return {
    view: (runId) => request(path(runId), viewSchema, { method: "GET" }),
    double: (runId, sessionId) => request(path(runId), resultSchema, { method: "POST", body: { sessionId } }),
  };
}

/**
 * Кнопка удвоения: `hidden` — удваивать нечего, поздно или рекламы для
 * площадки нет (и нет VIP); `wait` — место отдыхает, но окно ещё открыто;
 * `doubled` — уже удвоено. `pass` — VIP, без ролика.
 */
export type DoubleButton =
  | { kind: "hidden" }
  | { kind: "ready"; coins: number; pass: boolean }
  | { kind: "wait"; coins: number; untilMs: number; pass: boolean }
  | { kind: "doubled"; coins: number };

export function doubleButton(view: RunDoubleView, nowMs: number, playable: boolean): DoubleButton {
  if (view.status === "doubled") return { kind: "doubled", coins: view.coins };
  if (view.status !== "available" || view.coins <= 0) return { kind: "hidden" };
  const pass = view.ad.pass !== null;
  const closesMs = Date.parse(view.until);
  if (!view.ad.available || (!pass && !playable) || closesMs <= nowMs) return { kind: "hidden" };
  const readyMs = view.ad.readyAt === null ? 0 : Date.parse(view.ad.readyAt);
  if (readyMs <= nowMs) return { kind: "ready", coins: view.coins, pass };
  // Кулдаун кончится после окна — ждать бесполезно, кнопки нет.
  return readyMs < closesMs ? { kind: "wait", coins: view.coins, untilMs: readyMs, pass } : { kind: "hidden" };
}

/**
 * Чем кончилось нажатие: `doubled` — монеты легли; `stale` — экран устарел
 * (уже удвоено, окно прошло, место отдыхает) и перечитывается;
 * `restricted` — награды за рекламу закрыты ограничением (WP44), при выдаче
 * или, если его наложили между выдачей и забором, при заборе; остальное —
 * исход рекламы.
 */
export type DoubleOutcome =
  | { kind: "doubled"; result: RunDoubleResult }
  | { kind: "stale"; code: string }
  | { kind: "closed" | "no_ads" | "restricted" | "failed" };

/** Ролик (или VIP) — и сессия показа сразу в удвоение. `rewarded` — награда выдана: для `ad_reward_claimed`. */
export async function doubleForAd(
  runId: string,
  watch: () => Promise<AdWatchResult>,
  api: Pick<RunDoubleApi, "double">,
  rewarded: (source: "ad" | "pass") => void,
): Promise<DoubleOutcome> {
  const watched = await watch();
  if (watched.kind === "cooldown") return { kind: "stale", code: RUN_DOUBLE_COOLDOWN };
  if (watched.kind !== "watched") return { kind: watched.kind };
  const response = await api.double(runId, watched.sessionId);
  if (response.ok) {
    rewarded(watched.source);
    return { kind: "doubled", result: response.data };
  }
  const code = response.code ?? "";
  if (code === RESTRICTED_CODE) return { kind: "restricted" };
  return code === RUN_ALREADY_DOUBLED || code === RUN_DOUBLE_UNAVAILABLE || code === RUN_DOUBLE_COOLDOWN ? { kind: "stale", code } : { kind: "failed" };
}
