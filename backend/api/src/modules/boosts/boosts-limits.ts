import type { RateLimit } from "../ingest/rate-limiter.js";

/**
 * Частота по аккаунту (docs/30-configuration-map.md). Покупка — раз на забег,
 * возврат — раз на несостоявшийся старт, каталог — на экране выбора: сотня
 * в час — уже не игрок.
 */
export const BOOST_LIMITS: Record<"read" | "write", RateLimit> = {
  read: { scope: "boosts:read", limit: 600, windowSec: 3600 },
  write: { scope: "boosts:write", limit: 120, windowSec: 3600 },
};

/**
 * Возврат бустов забегу, который так и не начался: проход раз в десять
 * минут, окно — шесть часов. Короче нельзя: старт честного забега мог
 * пролежать в очереди без сети, и возврат до его прихода подарил бы бусты
 * даром. Проход — под локом и пачкой: при нескольких репликах возвращает одна.
 */
export const BOOST_REFUND = { tickMs: 10 * 60_000, windowMs: 6 * 3600_000, batch: 100, lockTtlMs: 5 * 60_000 } as const;
