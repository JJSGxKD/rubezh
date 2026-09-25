import type { RateLimit } from "../ingest/rate-limiter.js";

/**
 * Числа дружбы (docs/35-stage4-plan.md, О15). **Рабочие** (Р31): поставлены
 * сразу, чтобы механика работала, и меняются, когда появится редактор
 * баланса (WP17) или решение команды. Потолки — чтобы добавляться было
 * выгодно, а строить ферму аккаунтов — нет (§3.8).
 */
export const FRIENDS_RULES = {
  /** потолок друзей у аккаунта — рабочее */
  maxFriends: 100,
  /** сколько входящих заявок ждёт ответа одновременно — рабочее */
  maxIncomingRequests: 50,
  /** сколько своих заявок висит без ответа — рабочее */
  maxOutgoingRequests: 50,
} as const;

/**
 * Лимиты частоты по аккаунту. Заявка — сообщение другому человеку, поэтому
 * её лимит суточный и тесный: иначе раздел друзей становится рассылкой.
 */
export const FRIENDS_LIMITS = {
  read: { scope: "friends:read", limit: 600, windowSec: 3600 },
  change: { scope: "friends:change", limit: 120, windowSec: 3600 },
  request: { scope: "friends:request", limit: 30, windowSec: 86_400 },
} as const satisfies Record<string, RateLimit>;
