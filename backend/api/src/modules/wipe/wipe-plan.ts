import type { Prisma } from "../../generated/prisma/client.js";

/**
 * План вайпа перед публичным лончем: что с каждой таблицей базы делает
 * команда вайпа. Решения — Р87 (docs/35-stage4-plan.md) и решения тимлидов
 * по отдельным таблицам. Остаются люди и всё, что настраивает команда,
 * стирается игровой прогресс.
 *
 * Стирать только построчно (`deleteMany`) и в порядке `WIPE_ORDER`.
 * `TRUNCATE` запрещён: на `Run` ссылается `Purchase` (`onDelete: Restrict`),
 * и `TRUNCATE … CASCADE` стёр бы журнал покупок, который не стирается никогда.
 * Порядок не вычисляется из связей `onDelete: Cascade`, а задан списком —
 * так он читается в ревью.
 *
 * Новая модель в схеме обязана получить строку в `WIPE_PLAN`: иначе падает
 * `test/wipe-plan.test.ts`, а вайп не застанет таблицу врасплох.
 */

/** Что делает вайп с таблицей (docs/35-stage4-plan.md, Р87). */
export type WipeAction = "keep" | "wipe";

export interface WipeDecision {
  action: WipeAction;
  /** Почему — по-русски, одной фразой: читается в ревью и в отчёте команды вайпа. */
  why: string;
}

const keep = (why: string): WipeDecision => ({ action: "keep", why });
const wipe = (why: string): WipeDecision => ({ action: "wipe", why });

/** Решение по каждой модели Prisma. Новая модель без строки здесь — падение теста. */
export const WIPE_PLAN: Record<Prisma.ModelName, WipeDecision> = {
  // --- остаются: люди, их настройки и история ---
  Account: keep("аккаунт, имя и аватар остаются (Р87)"),
  AccountSettings: keep("настройки игрока остаются"),
  TestNotice: keep("принятое предупреждение о тесте остаётся"),
  AccountRole: keep("роли команды"),
  AuditEntry: keep("журнал действий команды"),
  AccountRestriction: keep("ограничения действуют и после вайпа"),
  Purchase: keep("журнал покупок не стирается никогда; по нему возвращается купленное"),
  VipSubscription: keep("подписка VIP остаётся"),
  VipPeriod: keep("неистёкший VIP остаётся"),
  AnalyticsEvent: keep("аналитика задним числом не восстанавливается"),
  AccountSession: keep("сессии запуска — атрибуция и аналитика"),
  Acquisition: keep("первое и последнее касание"),
  AccountFunnel: keep("вехи воронки — факты истории аккаунта"),
  AccountMessaging: keep("можно ли писать игроку"),
  DiagnosticReport: keep("отчёты диагностики команде"),
  Feedback: keep("отзывы игроков"),
  DataExport: keep("журнал выгрузок"),

  // --- остаются: друзья, приглашения, привязки ---
  FriendLink: keep("ссылка дружбы остаётся"),
  Friendship: keep("друзья остаются"),
  FriendRequest: keep("заявки в друзья остаются"),
  ReferralBinding: keep("привязка приглашения навсегда; награды заново не начисляются"),
  FriendReturn: keep("пара за возвращение награждается однажды"),
  FriendBonus: keep("ступень бонуса за друзей — один раз навсегда"),
  PartnerBinding: keep("слот источника игрока навсегда"),
  Partner: keep("партнёры команды"),
  TaskParticipant: keep("место в лимите партнёрского задания занимается однажды"),
  PromoRedemption: keep("погашенный код погашен навсегда"),

  // --- остаются: то, что настраивает команда ---
  PromoCampaign: keep("кампании промокодов команды"),
  PromoCode: keep("коды команды"),
  TaskDef: keep("каталог заданий команды"),
  ShopPromo: keep("акции магазина команды"),
  HomeSlide: keep("слайды главной команды"),
  MediaImage: keep("картинки панели"),
  Link: keep("ссылки кампаний"),
  LinkClick: keep("клики по ссылкам — атрибуция"),
  AdNetwork: keep("настройка рекламных сетей"),
  NetworkTask: keep("настройка заданий сетей"),
  AdBlock: keep("рекламные блоки"),
  AdSession: keep("воронка показов рекламы — аналитика"),
  AdConversion: keep("журнал постбэков сетям"),
  Broadcast: keep("рассылки команды"),
  BroadcastDelivery: keep("кому рассылка дошла"),
  ChangelogEntry: keep("журнал обновлений"),
  ChangelogSource: keep("откуда строки журнала"),
  ChangelogRelease: keep("раздача уведомлений о версиях"),
  ChangelogSeen: keep("когда игрок открывал журнал"),
  FeatureFlag: keep("флаги команды"),
  AppSetting: keep("настройки без релиза"),
  IntegrationSecret: keep("ключи интеграций"),

  // --- остаются: курсы валют ---
  FxQuote: keep("курсы валют — не данные игрока"),
  FxRateCurrent: keep("курсы валют — не данные игрока"),
  FxRateHistory: keep("курсы валют — не данные игрока"),
  FxManualRate: keep("курсы валют — не данные игрока"),
  FxSnapshot: keep("снимки курсов — на них ссылаются цены и платежи"),
  FxSourceState: keep("состояние источников курсов"),

  // --- стираются: игровой прогресс ---
  RunAdContinue: wipe("второй шанс за рекламу — часть забега"),
  RunReward: wipe("награда за забег"),
  RunBoost: wipe("бусты на забег"),
  TaskRun: wipe("забеги, засчитанные заданиям"),
  Run: wipe("забеги и рейтинги стираются (Р87); ссылку покупки на забег обнуляет T-0041"),
  TaskProgress: wipe("прогресс заданий начинается заново"),
  ShowcaseOffer: wipe("предложения витрины ссылаются на предметы"),
  ItemEvent: wipe("журнал предметов"),
  Item: wipe("снаряжение стирается"),
  WalletEntry: wipe("журнал кошелька; купленное возвращается снимком (T-0040)"),
  WalletBalance: wipe("баланс — проекция журнала"),
  WalletDaily: wipe("суточные потолки начислений"),
  AccountProgress: wipe("уровень и опыт; уровень уходит в снимок (T-0040)"),
  FriendGift: wipe("подарки друзьям — валюта"),
  DailyReward: wipe("награда дня начинается заново"),
  WheelSpin: wipe("крутки колеса"),
  VipDaily: wipe("день забора самоцветов VIP"),
  Notification: wipe("лента уведомлений"),
};

/** Порядок стирания: дочерние раньше родительских. Ровно модели с `action: "wipe"`. */
export const WIPE_ORDER: readonly Prisma.ModelName[] = [
  "RunAdContinue",
  "RunReward",
  "RunBoost",
  "TaskRun",
  "Run",
  "TaskProgress",
  "ShowcaseOffer",
  "ItemEvent",
  "Item",
  "WalletEntry",
  "WalletBalance",
  "WalletDaily",
  "AccountProgress",
  "FriendGift",
  "DailyReward",
  "WheelSpin",
  "VipDaily",
  "Notification",
];
