import type { Permission } from "../roles/permissions.js";

/**
 * Ограничения игрока (docs/35-stage4-plan.md Р75, WP44, О40): наказание по
 * мере проступка — закрыть то, чем игрок злоупотребил, на срок, и не трогать
 * остальное. Блокировка целиком — тот же вид «всё».
 *
 * Каталог — данные: что закрывает вид словами (панель показывает это до
 * наложения), где он проверяется и чьё право нужно. Новый вид без проверки в
 * своём модуле роняет контрактный тест (`restrictions.test.ts`).
 *
 * Ограниченное не копится: награда, не выданная за время ограничения, потом
 * не приходит — иначе ограничение было бы отсрочкой.
 */

export const RESTRICTION_KINDS = ["leaderboard", "referral_rewards", "friend_gifts", "ad_rewards", "promo_codes", "partner_tasks", "all"] as const;

export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

export interface RestrictionKindInfo {
  /** имя в панели и в плашке игрока */
  title: string;
  /** что игрок теряет — панель показывает до наложения */
  effect: string;
  /** где проверяется — модуль, который отказывает */
  checkedIn: string;
  permission: Permission;
  /** можно ли наложить молча, без плашки у игрока */
  silentAllowed: boolean;
}

export const RESTRICTION_CATALOG: Record<RestrictionKind, RestrictionKindInfo> = {
  leaderboard: {
    title: "Рейтинг",
    effect:
      "Игрок сразу пропадает из досок, забеги за это время в рейтинг не попадают — и потом не засчитаются. Когда срок выйдет, вернётся с лучшим забегом до ограничения. Молча — тень: игрок видит себя в досках на своём месте, другие его не видят.",
    checkedIn: "runs",
    permission: "players.restrict",
    silentAllowed: true,
  },
  referral_rewards: {
    title: "Награды за друзей",
    effect:
      "Не начисляются награды за приглашённых и за вернувшихся друзей — и потом не придут. Бонус за число друзей не забирается, пока действует ограничение.",
    checkedIn: "referrals, friends",
    permission: "players.restrict",
    silentAllowed: true,
  },
  friend_gifts: {
    title: "Подарки друзьям",
    effect: "Нельзя дарить и забирать подарки. Подарки, пришедшие за это время, сгорают по обычному сроку.",
    checkedIn: "friends",
    permission: "players.restrict",
    silentAllowed: true,
  },
  ad_rewards: {
    title: "Награды за рекламу",
    effect: "Реклама за награду не предлагается: крутка колеса, удвоение награды за забег, второй шанс. Начатый просмотр награду не принесёт.",
    checkedIn: "ads",
    permission: "players.restrict",
    silentAllowed: true,
  },
  promo_codes: {
    title: "Промокоды",
    effect: "Промокоды не погашаются.",
    checkedIn: "promo-codes",
    permission: "players.restrict",
    silentAllowed: true,
  },
  partner_tasks: {
    title: "Партнёрские задания",
    effect: "Задания во вкладке «Партнёры» — свои и рекламных сетей — не выдают награду, задания сетей не показываются.",
    checkedIn: "tasks",
    permission: "players.restrict",
    silentAllowed: true,
  },
  all: {
    title: "Всё — блокировка",
    effect:
      "Вход в игру закрыт, сессии игры и панели отзываются сразу; игрок пропадает из досок рейтинга, как при ограничении рейтинга. Молча не накладывается: игрок всё равно увидит отказ при входе.",
    checkedIn: "auth",
    permission: "players.ban",
    silentAllowed: false,
  },
};

/**
 * Причины — шаблонами (О40): игрок видит текст шаблона, комментарий — только
 * команда. Шаблон, а не свободный текст: так причины одинаковы у всех
 * модераторов и считаются в разборе.
 */
export const RESTRICTION_REASONS = {
  leaderboard_cheat: { title: "Накрутка рейтинга", player: "Подозрительные забеги в рейтинге" },
  multiaccount: { title: "Мультиаккаунты ради наград", player: "Награды с нескольких аккаунтов одного человека" },
  ad_abuse: { title: "Злоупотребление рекламой", player: "Неестественные просмотры рекламы" },
  promo_abuse: { title: "Злоупотребление промокодами", player: "Промокоды использовались не по правилам" },
  abuse: { title: "Оскорбления или спам", player: "Оскорбления или спам" },
  other: { title: "Другое", player: "Нарушение правил игры" },
} as const satisfies Record<string, { title: string; player: string }>;

export type RestrictionReason = keyof typeof RESTRICTION_REASONS;

export const RESTRICTION_REASON_KEYS = Object.keys(RESTRICTION_REASONS) as [RestrictionReason, ...RestrictionReason[]];

export const RESTRICTION_LIMITS = {
  /** комментарий команды к наложению и к снятию */
  commentMax: 500,
  /** короче — это не наказание, а опечатка в дате */
  minTermMs: 10 * 60_000,
  /** «до даты» дальше пяти лет — это «бессрочно», и его так и выбирают */
  maxTermMs: 5 * 366 * 86_400_000,
} as const;

export function isRestrictionKind(value: string): value is RestrictionKind {
  return (RESTRICTION_KINDS as readonly string[]).includes(value);
}
