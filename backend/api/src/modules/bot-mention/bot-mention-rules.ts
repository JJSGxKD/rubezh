import type { MentionKind } from "../../platforms/ports/bot-mention.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import type { SettingsReader } from "../settings/settings.service.js";

/**
 * Правила заданий «юзернейм бота» (docs/35-stage4-plan.md Р110, tasks/T-0162):
 * виды, исходы, награда из настроек панели и серия. Чистые функции без
 * базы и площадки — их проверяет `bot-mention.test.ts`.
 */

/** Где проверяется юзернейм: в показываемом имени или в «о себе». Те же значения, что у порта площадки. */
export const BOT_MENTION_KINDS = ["name", "bio"] as const satisfies readonly MentionKind[];

export type BotMentionKind = (typeof BOT_MENTION_KINDS)[number];

/** Исход проверки, как он хранится в таблице: к трём исходам порта добавлено «проверить нельзя». */
export const BOT_MENTION_RESULTS = ["present", "absent", "hidden", "unavailable"] as const;

export type BotMentionResult = (typeof BOT_MENTION_RESULTS)[number];

export interface BotMentionReward {
  coins: number;
  gems: number;
  /** обычные осколки */
  shards: number;
}

export function noReward(): BotMentionReward {
  return { coins: 0, gems: 0, shards: 0 };
}

/** Состояние задания игрока: текста имени и bio здесь нет и не бывает. */
export interface BotMentionRow {
  accountId: string;
  kind: BotMentionKind;
  startedAt: Date;
  /** серия на последние сутки с наградой; на экране — `activeStreak` */
  streak: number;
  bestStreak: number;
  rewardedDays: number;
  /** последние игровые сутки с наградой, `YYYY-MM-DD` */
  lastDay: string | null;
  /** игровые сутки последней проверки с исходом, `YYYY-MM-DD` */
  checkedDay: string | null;
  checkedAt: Date | null;
  lastResult: BotMentionResult | null;
}

/**
 * Ночной проход: на сколько секунд темпа он берёт аккаунтов. Темп бота
 * делят рассылки, уведомления и проверки игроков, поэтому проход тратит его
 * половину (`bot-mention-sweep.service.ts`).
 */
export const SWEEP_BUDGET_SEC = 240;

/** Как часто планировщик запускает проход: аккаунт за сутки проверяется один раз, остальное — очередь. */
export const SWEEP_INTERVAL_MS = 300_000;

/**
 * Порт просит id игрока строкой, а адаптер Telegram переводит его в число:
 * число длиннее 15 цифр теряет точность (больше `Number.MAX_SAFE_INTEGER`).
 * Реальные id Telegram укладываются в 52 бита, так что настоящему игроку
 * ограничение не мешает. Всё остальное — аккаунт разработчика (`dev-…`) или
 * мусор — на площадку не уходит.
 */
const PORT_USER_ID = /^\d{1,15}$/;

export function canCheckUserId(platformUserId: string): boolean {
  return PORT_USER_ID.test(platformUserId);
}

const DAY_MS = 86_400_000;

/** Предыдущие сутки по календарю: дата без времени в UTC, пояс процесса не влияет. */
export function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/**
 * Серия на экране: живёт, пока последняя награда — сегодня или вчера
 * (сегодняшние сутки ещё не кончились, и игрок может успеть). Раньше —
 * серия оборвана: она обнуляется без штрафа, лучшая серия остаётся.
 */
export function activeStreak(row: Pick<BotMentionRow, "streak" | "lastDay">, today: string): number {
  if (row.lastDay === null) return 0;
  return row.lastDay === today || row.lastDay === previousDay(today) ? row.streak : 0;
}

const REWARD_SETTINGS = {
  name: { coins: SETTINGS.botMentionNameCoins, gems: SETTINGS.botMentionNameGems, shards: SETTINGS.botMentionNameShards },
  bio: { coins: SETTINGS.botMentionBioCoins, gems: SETTINGS.botMentionBioGems, shards: SETTINGS.botMentionBioShards },
} as const satisfies Record<BotMentionKind, Record<keyof BotMentionReward, unknown>>;

/** Награда за сутки по настройкам панели. Размер не зависит от серии: надбавки за длину серии нет. */
export function rewardOf(kind: BotMentionKind, settings: SettingsReader): BotMentionReward {
  const keys = REWARD_SETTINGS[kind];
  return { coins: settings.get(keys.coins), gems: settings.get(keys.gems), shards: settings.get(keys.shards) };
}

/** Вид без награды игроку не показывается и не проверяется. */
export function offered(reward: BotMentionReward): boolean {
  return reward.coins + reward.gems + reward.shards > 0;
}

/** Виды, которые сейчас показываются и проверяются: функция включена и награда вида больше нуля. */
export function offeredKinds(settings: SettingsReader): BotMentionKind[] {
  if (!settings.get(SETTINGS.botMentionEnabled)) return [];
  return BOT_MENTION_KINDS.filter((kind) => offered(rewardOf(kind, settings)));
}
