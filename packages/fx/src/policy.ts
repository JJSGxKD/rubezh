import type { AcceptPolicy } from "./accept.js";
import type { CurrencyKind } from "./currencies.js";
import { Decimal } from "./decimal.js";
import type { FreshnessPolicy } from "./freshness.js";

/**
 * Пороги модуля курсов — рабочие значения (docs/35-stage4-plan.md, Р31):
 * меняются здесь, в карте конфигурации — docs/30-configuration-map.md.
 *
 * **Фиат** стабилен и официален: ЦБ и ЕЦБ публикуют раз в рабочий день,
 * поэтому котировка живёт неделю (длинные выходные), а сдвиг больше 5% за
 * одно обновление без второго источника — скорее ошибка разбора, чем рынок.
 *
 * **Крипта** волатильна: Gram может сходить на 15% за день, и порог скачка
 * шире. Котировка старше получаса — уже не рынок.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Срок одного запроса к источнику: ответ курсов — килобайты, дольше десяти секунд — уже сбой. */
export const SOURCE_TIMEOUT_MS = 10_000;

/** Неизменный курс пишется в историю не чаще раза в час (`refresh.ts`). */
export const HISTORY_REPEAT_MS = HOUR;

export const ACCEPT_POLICY: Record<Exclude<CurrencyKind, "platform">, AcceptPolicy> = {
  fiat: { maxQuoteAgeMs: 7 * DAY, maxClockSkewMs: DAY, jumpThreshold: new Decimal("0.05"), agreement: new Decimal("0.01") },
  crypto: { maxQuoteAgeMs: 30 * MINUTE, maxClockSkewMs: 5 * MINUTE, jumpThreshold: new Decimal("0.15"), agreement: new Decimal("0.03") },
};

/**
 * Свежесть принятого курса. «Устарел» — алерт `rate_stale`, цены стоят;
 * «просрочен» — продавать по нему больше нельзя (§3.12). У фиата запас —
 * новогодние каникулы ЦБ, у крипты — сутки: цены в Gram пересчитываются по
 * расписанию, а не от каждого обновления, и курс шестичасовой давности для
 * них ещё годен. Заданный курс площадки устаревает в свой срок годности, а
 * продавать по нему можно ещё месяц — цены в звёздах ставятся руками.
 */
export const FRESHNESS_POLICY: Record<CurrencyKind, FreshnessPolicy> = {
  fiat: { staleAfterMs: 5 * DAY, sellableForMs: 30 * DAY },
  crypto: { staleAfterMs: 30 * MINUTE, sellableForMs: DAY },
  platform: { staleAfterMs: 0, sellableForMs: 30 * DAY },
};
