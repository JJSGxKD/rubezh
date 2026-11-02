import { randomUUID } from "node:crypto";
import { withTimeout } from "../../../common/with-timeout.js";

/**
 * Замок и метки «не чаще раза в минуту» на Redis (docs/35-stage4-plan.md Р101):
 * при нескольких репликах API подписку обновляет и узлы проверяет одна, а
 * кнопки панели не чаще раза в минуту на всех. Устройство то же, что у
 * обновления курсов (`modules/fx/fx.refresher.ts`): `SET NX PX` и снятие
 * только своим токеном.
 */

/** Что нужно от Redis: настоящий клиент и подмена теста подходят под эти две команды. */
export interface LockRedis {
  set(key: string, value: string, mode: "PX", ttlMs: number, nx: "NX"): Promise<"OK" | null>;
  eval(script: string, keys: number, key: string, token: string): Promise<unknown>;
}

export const REFRESH_LOCK_KEY = "proxy-subscription:refresh:lock";
/** Срок замка — худший проход: загрузка подписки, запись и проверки узлов. */
export const REFRESH_LOCK_TTL_MS = 120_000;
const REDIS_TIMEOUT_MS = 2_000;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export type LockResult<T> = { ran: true; value: T } | { ran: false };

/**
 * Выполнить `work` под замком. Замок у другой реплики или Redis недоступен —
 * `ran: false`: работа не запускается, а не идёт мимо замка (бюджет запросов
 * к поставщику считает замок).
 */
export async function withLock<T>(redis: LockRedis, key: string, ttlMs: number, work: () => Promise<T>): Promise<LockResult<T>> {
  const token = randomUUID();
  let claimed: "OK" | null;
  try {
    claimed = await withTimeout(redis.set(key, token, "PX", ttlMs, "NX"), REDIS_TIMEOUT_MS, "замок подписки");
  } catch {
    return { ran: false };
  }
  if (claimed === null) return { ran: false };
  try {
    return { ran: true, value: await work() };
  } finally {
    await withTimeout(redis.eval(RELEASE_SCRIPT, 1, key, token), REDIS_TIMEOUT_MS, "снятие замка подписки").catch(() => undefined);
  }
}

/** Метка «действие было минуту назад»; `true` — действие разрешено и метка поставлена. */
export async function takeMinute(redis: Pick<LockRedis, "set">, key: string): Promise<boolean> {
  try {
    return (await withTimeout(redis.set(key, "1", "PX", 60_000, "NX"), REDIS_TIMEOUT_MS, "метка подписки")) !== null;
  } catch {
    // Без Redis ограничение не поставить; кнопку не блокируем — она за правом proxies.edit.
    return true;
  }
}
