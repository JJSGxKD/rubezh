import type { RateLimit } from "../ingest/rate-limiter.js";
import type { EarnReason, ExchangeReason, WalletResource } from "./wallet-types.js";

/**
 * Страховки кошелька (docs/35-stage4-plan.md, §3.2). Меняются здесь, в карте
 * конфигурации — docs/30-configuration-map.md.
 *
 * **Суточные потолки — рабочие значения** (Р31): чисел экономики ещё нет
 * (О1, О2), и потолок стоит с запасом, чтобы честный игрок в него не упёрся
 * никогда. Когда появятся формулы наград (WP4, WP13), потолок встаёт на
 * 5–10 дневных максимумов активного игрока: ошибка в числах на порядок и
 * накрутка упираются в него в первые же сутки.
 *
 * Потолок заодно и **список разрешённого**: валюты, которой нет у
 * источника, он не начисляет вовсе. Реклама не даёт самоцветов, пока здесь
 * не написано обратное, — и это видно в диффе.
 */
export const WALLET_DAILY_CAPS: Record<EarnReason, Partial<Record<WalletResource, number>>> = {
  run_reward: { coins: 20_000 },
  level_reward: { coins: 10_000, gems: 100 },
  // Самоцветов в награде дня нет (О14); седьмой день даёт обычные осколки —
  // потолок в разы выше самого щедрого дня (~1 430 монет и 16 осколков).
  daily_reward: { coins: 5_000, shard_common: 100 },
  // Каталог по умолчанию (`tasks` в миграции) — ~3 300 монет и 23 осколка,
  // если в один день закрыты все ежедневные и недельные; самоцветов у них нет,
  // но панель вправе их дать.
  task_reward: { coins: 10_000, gems: 50, shard_common: 100 },
  achievement_reward: { coins: 20_000, gems: 200 },
  // Самоцветов на колесе нет (Р11, п. 5) — и кошелёк их по этой причине не
  // начислит. Самая щедрая крутка — 2 980 монет на сотом уровне
  // (`wheel/wheel-rules.ts`), а круток в сутки не больше семи: бесплатная и
  // шесть за рекламу при растущем кулдауне (`ads/ads-rules.ts`). Потолок
  // держит семь самых щедрых, и честный игрок в него не упрётся.
  wheel_reward: { coins: 21_000, shard_common: 100, shard_uncommon: 20 },
  friend_gift: { coins: 2_000 },
  // все ступени бонуса за друзей — 950 монет: даже забранные разом, они проходят
  friend_bonus: { coins: 1_000 },
  referral_reward: { coins: 20_000, gems: 100 },
  ad_reward: { coins: 10_000 },
  subscription_daily: { gems: 30 },
  season_reward: { coins: 50_000, gems: 500 },
};

/**
 * Что даёт обмен. Монеты не продаются (Р2), поэтому покупка — только
 * самоцветы; разбор предмета — только осколки; возврат буста — то, чем он
 * оплачен.
 */
export const EXCHANGE_RESOURCES: Record<ExchangeReason, readonly WalletResource[]> = {
  purchase: ["gems"],
  salvage: ["shard_common", "shard_uncommon", "shard_rare", "shard_epic", "shard_legendary", "shard_mythic"],
  // Возвращается ровно то, чем бусты оплачивают (Р39), — не больше.
  boost_refund: ["coins", "gems"],
};

/**
 * Потолок одной операции — от опечатки в панели и ошибки в формуле: «десять
 * миллионов монет одним начислением» не бывает честным ни при каких числах.
 */
export const WALLET_MAX_OPERATION = 10_000_000;

/**
 * Частота по аккаунту. Кошелёк читают шапка и экран итогов — это единицы в
 * минуту; ручные операции делает человек в панели.
 */
export const WALLET_LIMITS: Record<"read" | "adjust", RateLimit> = {
  read: { scope: "wallet:read", limit: 600, windowSec: 3600 },
  adjust: { scope: "wallet:adjust", limit: 60, windowSec: 3600 },
};
