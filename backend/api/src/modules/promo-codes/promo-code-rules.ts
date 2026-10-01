import { z } from "zod";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import type { WalletResource } from "../wallet/wallet-types.js";

/**
 * Промокоды (docs/35-stage4-plan.md WP41, Р74; docs/23-referral-and-partner-program.md §3).
 *
 * Кампания — то, что заводит команда: один **общий код** на всех (стрим,
 * пост, событие) или **пачка одноразовых** (розыгрыш, призы). Игрок
 * активирует кампанию один раз: второй код той же пачки награды не даст —
 * иначе раздачу собрал бы один человек.
 *
 * Код вводят руками на телефоне, часто — услышав его на стриме. Поэтому ключ
 * кода не зависит от регистра, пробелов и дефисов, а кириллица, которую на
 * глаз не отличить от латиницы, сведена к латинице: «рубеж 2026»,
 * «РУБЕЖ-2026» и «Рубеж2026» — один код, а «РЕКА» на русской раскладке
 * совпадёт с «PEKA» на английской. Коды пачки собраны только из таких букв и
 * цифр — их можно набрать с любой раскладки, не переключая её.
 */

export const PROMO_REWARD_RESOURCES = ["coins", "gems", "shard_common", "shard_uncommon"] as const satisfies readonly WalletResource[];
export type PromoRewardResource = (typeof PROMO_REWARD_RESOURCES)[number];
export type PromoReward = Record<PromoRewardResource, number>;

export const PROMO_KINDS = ["shared", "batch"] as const;
export type PromoKind = (typeof PROMO_KINDS)[number];

export const PROMO_CODE_LIMITS = {
  /**
   * Потолок награды одного кода. Самоцветы — меньше полутора наборов за
   * звёзды (`shop/shop-catalog.ts`): промокод — подарок, а не замена покупке.
   * Суточный потолок кошелька `promo_reward` — два таких кода.
   */
  reward: { coins: 50_000, gems: 300, shard_common: 200, shard_uncommon: 50 } satisfies PromoReward,
  codeMinLength: 4,
  codeMaxLength: 24,
  prefixMaxLength: 8,
  batchMax: 1_000,
  /** случайная часть кода пачки: 17⁸ ≈ 7·10⁹ вариантов против десяти попыток за десять минут */
  batchRandomLength: 8,
  maxRedemptions: 1_000_000,
  newPlayersMaxDays: 90,
  /** дальше вперёд не заводится: к тому времени забудут, зачем код */
  aheadDays: 90,
  /** короче — опечатка в сроке, а не кампания */
  minHours: 1,
  titleMax: 80,
  noteMax: 200,
  messageMax: 160,
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** запас на часы панели: «начать сейчас» доходит до сервера через секунды */
const PAST_GRACE_MS = 5 * 60_000;

/** Кириллица, которую на глаз не отличить от латиницы, и Ё — к латинице. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  А: "A",
  В: "B",
  Е: "E",
  Ё: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  У: "Y",
};
const LOOKALIKE = /[АВЕЁКМНОРСТХУ]/g;
const SEPARATORS = /[\s\-_.]+/g;
const KEY = /^[A-Z0-9А-Я]+$/;
/** как код можно записать: буквы и цифры, группы — через пробел или дефис */
const DISPLAY = /^[A-ZА-ЯЁ0-9]+(?:[ -][A-ZА-ЯЁ0-9]+)*$/;

/** Ключ кода: то, по чему он ищется. */
export function codeKey(raw: string): string {
  return raw
    .normalize("NFC")
    .toUpperCase()
    .replace(SEPARATORS, "")
    .replace(LOOKALIKE, (letter) => LOOKALIKES[letter] ?? letter);
}

/** Как код показывать: заглавными, пробелы схлопнуты. */
export function codeDisplay(raw: string): string {
  return raw.normalize("NFC").trim().toUpperCase().replace(/\s+/g, " ");
}

/** Почему так код не записать; `null` — можно. */
export function codeProblem(raw: string): string | null {
  const display = codeDisplay(raw);
  if (!DISPLAY.test(display)) return "Только буквы и цифры, группы — через пробел или дефис";
  const key = codeKey(display);
  if (!KEY.test(key)) return "Только буквы и цифры";
  if (key.length < PROMO_CODE_LIMITS.codeMinLength) return `Не короче ${String(PROMO_CODE_LIMITS.codeMinLength)} знаков — короткий код угадывают перебором`;
  if (key.length > PROMO_CODE_LIMITS.codeMaxLength) return `Не длиннее ${String(PROMO_CODE_LIMITS.codeMaxLength)} знаков без пробелов и дефисов`;
  return null;
}

export function prefixProblem(raw: string): string | null {
  const key = codeKey(raw);
  if (key === "") return null;
  if (!KEY.test(key) || /[\s-]/.test(raw.trim())) return "Приставка — одно слово из букв и цифр";
  if (key.length > PROMO_CODE_LIMITS.prefixMaxLength) return `Приставка — не длиннее ${String(PROMO_CODE_LIMITS.prefixMaxLength)} знаков`;
  return null;
}

/**
 * Буквы и цифры кодов пачки: латиница, у которой есть двойник в кириллице, —
 * код набирается с любой раскладки. Без O и 0, I и 1, B и 8 — их путают на
 * слух и в мелком шрифте.
 */
export const BATCH_ALPHABET = "ACEHKMPTXY2345679";

/** Код пачки: «ZIMA-K7MP-3XTE». `pick(n)` — случайное целое от 0 до n−1. */
export function batchCode(prefix: string, pick: (size: number) => number): { code: string; display: string } {
  let random = "";
  for (let index = 0; index < PROMO_CODE_LIMITS.batchRandomLength; index += 1) random += BATCH_ALPHABET.charAt(pick(BATCH_ALPHABET.length));
  const half = PROMO_CODE_LIMITS.batchRandomLength / 2;
  const head = codeDisplay(prefix);
  const display = [head, random.slice(0, half), random.slice(half)].filter((part) => part !== "").join("-");
  return { code: codeKey(display), display };
}

const amount = (max: number) => z.number().int().min(0).max(max);
const moment = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === null || value === "" ? null : value));

export const promoRewardSchema = z
  .object({
    coins: amount(PROMO_CODE_LIMITS.reward.coins),
    gems: amount(PROMO_CODE_LIMITS.reward.gems),
    shard_common: amount(PROMO_CODE_LIMITS.reward.shard_common),
    shard_uncommon: amount(PROMO_CODE_LIMITS.reward.shard_uncommon),
  })
  .strict()
  .refine((reward) => PROMO_REWARD_RESOURCES.some((resource) => reward[resource] > 0), { message: "код без награды" });

const issueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("shared"),
      code: z.string().max(48),
      /** `null` — без лимита */
      maxRedemptions: z.number().int().min(1).max(PROMO_CODE_LIMITS.maxRedemptions).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("batch"),
      count: z.number().int().min(1).max(PROMO_CODE_LIMITS.batchMax),
      prefix: z.string().max(16),
    })
    .strict(),
]);

export type PromoIssue = z.infer<typeof issueSchema>;

const campaignShape = {
  title: z.string().trim().min(2).max(PROMO_CODE_LIMITS.titleMax),
  note: optionalText(PROMO_CODE_LIMITS.noteMax),
  message: optionalText(PROMO_CODE_LIMITS.messageMax),
  reward: promoRewardSchema,
  startsAt: moment,
  /** `null` — бессрочно */
  endsAt: moment.nullable(),
  newPlayersDays: z.number().int().min(1).max(PROMO_CODE_LIMITS.newPlayersMaxDays).nullable(),
  /** пусто — все площадки */
  platforms: z
    .array(z.enum(PLATFORM_IDS))
    .max(PLATFORM_IDS.length)
    .refine((list) => new Set(list).size === list.length, { message: "площадка повторяется" }),
};

export const promoCampaignInputSchema = z
  .object({
    ...campaignShape,
    issue: issueSchema,
    /** чей код: партнёра — активация ещё и привязывает новичка к нему; `null` — подарок команды. После заведения не меняется */
    partnerId: z.uuid().nullable().default(null),
  })
  .strict();
export type PromoCampaignInput = z.infer<typeof promoCampaignInputSchema>;

/** Правка: код, вид и партнёр не меняются; лимит — только у общего кода, у пачки он равен числу кодов. */
export const promoCampaignUpdateSchema = z
  .object({ ...campaignShape, maxRedemptions: z.number().int().min(1).max(PROMO_CODE_LIMITS.maxRedemptions).nullable() })
  .strict();
export type PromoCampaignUpdate = z.infer<typeof promoCampaignUpdateSchema>;

export interface PromoCampaignRow {
  campaignId: string;
  title: string;
  kind: PromoKind;
  reward: PromoReward;
  message: string | null;
  /** у пачки — число кодов */
  maxRedemptions: number | null;
  redeemed: number;
  startsAt: Date;
  endsAt: Date | null;
  newPlayersDays: number | null;
  platforms: PlatformId[];
  pausedAt: Date | null;
  note: string | null;
  /** чей код; `null` — подарок команды */
  partnerId: string | null;
  partnerName: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** общий код или первый код пачки — для списка в панели */
  codeSample: string;
}

/**
 * Где кампания сейчас. Кончившаяся по сроку — `expired`, даже если её
 * поставили на паузу: пауза уже ничего не меняет.
 */
export type PromoCampaignState = "scheduled" | "active" | "paused" | "expired" | "exhausted";

type StateFields = Pick<PromoCampaignRow, "startsAt" | "endsAt" | "pausedAt" | "redeemed" | "maxRedemptions">;

export function campaignState(campaign: StateFields, at: Date): PromoCampaignState {
  if (campaign.endsAt !== null && campaign.endsAt <= at) return "expired";
  if (campaign.maxRedemptions !== null && campaign.redeemed >= campaign.maxRedemptions) return "exhausted";
  if (campaign.pausedAt !== null) return "paused";
  if (campaign.startsAt > at) return "scheduled";
  return "active";
}

/** Сколько активаций осталось; `null` — без лимита. */
export function remaining(campaign: Pick<PromoCampaignRow, "redeemed" | "maxRedemptions">): number | null {
  return campaign.maxRedemptions === null ? null : Math.max(0, campaign.maxRedemptions - campaign.redeemed);
}

/** Почему этот игрок не может активировать код; `already` проверяется раньше — по записи погашения. */
export const REDEEM_REFUSALS = ["already", "scheduled", "paused", "expired", "exhausted", "used", "platform", "new_players"] as const;
export type RedeemRefusal = (typeof REDEEM_REFUSALS)[number];

export interface RedeemingPlayer {
  platform: PlatformId;
  createdAt: Date;
}

/**
 * Порядок проверок — от того, что игроку важнее знать: кончившийся код
 * незачем объяснять площадкой, а чужой код пачки — лимитом.
 */
export function redeemRefusal(
  campaign: StateFields & Pick<PromoCampaignRow, "platforms" | "newPlayersDays">,
  code: { redeemedBy: string | null },
  player: RedeemingPlayer,
  at: Date,
): RedeemRefusal | null {
  const state = campaignState(campaign, at);
  if (state === "expired") return "expired";
  if (code.redeemedBy !== null) return "used";
  if (state === "exhausted") return "exhausted";
  if (state === "paused") return "paused";
  if (state === "scheduled") return "scheduled";
  if (campaign.platforms.length > 0 && !campaign.platforms.includes(player.platform)) return "platform";
  if (campaign.newPlayersDays !== null && at.getTime() - player.createdAt.getTime() > campaign.newPlayersDays * DAY_MS) return "new_players";
  return null;
}

/** Срок кампании: начало не в прошлом и не слишком далеко, конец — после начала с запасом. */
export function periodProblem(period: { startsAt: Date; endsAt: Date | null }, at: Date, options: { startChanged: boolean; endChanged: boolean }): string | null {
  const { startsAt, endsAt } = period;
  if (options.startChanged && startsAt.getTime() < at.getTime() - PAST_GRACE_MS) return "Начало — не в прошлом";
  if (options.startChanged && startsAt.getTime() > at.getTime() + PROMO_CODE_LIMITS.aheadDays * DAY_MS) {
    return `Начало — не дальше чем через ${String(PROMO_CODE_LIMITS.aheadDays)} дней`;
  }
  if (endsAt === null) return null;
  if (endsAt.getTime() - startsAt.getTime() < PROMO_CODE_LIMITS.minHours * HOUR_MS) return "Код должен действовать хотя бы час";
  if (options.endChanged && endsAt <= at) return "Конец — в будущем; остановить код сейчас — пауза";
  return null;
}

/**
 * Что из правки можно применить к кампании. Награда и начало меняются, пока
 * код никто не активировал и он не начался: игроки, получившие одно,
 * не должны видеть, что другим дали другое.
 */
export function updateProblem(current: PromoCampaignRow, update: PromoCampaignUpdate, at: Date): string | null {
  const startChanged = update.startsAt.getTime() !== current.startsAt.getTime();
  if (startChanged && current.startsAt <= at) return "Код уже начал действовать — начало не поменять";
  const endChanged = (update.endsAt?.getTime() ?? null) !== (current.endsAt?.getTime() ?? null);
  const period = periodProblem(update, at, { startChanged, endChanged });
  if (period !== null) return period;
  if (current.redeemed > 0 && PROMO_REWARD_RESOURCES.some((resource) => update.reward[resource] !== current.reward[resource])) {
    return `Награду не поменять: код уже активировали ${String(current.redeemed)} раз — заведите новый код`;
  }
  if (current.kind === "batch" && update.maxRedemptions !== current.maxRedemptions) return "У пачки лимит — число кодов, его не поменять";
  if (update.maxRedemptions !== null && update.maxRedemptions < current.redeemed) {
    return `Лимит — не меньше уже сделанных активаций (${String(current.redeemed)})`;
  }
  return null;
}

/** Награда строкой для логов и аудита: только ненулевое. */
export function rewardLines(reward: PromoReward): { resource: PromoRewardResource; amount: number }[] {
  return PROMO_REWARD_RESOURCES.filter((resource) => reward[resource] > 0).map((resource) => ({ resource, amount: reward[resource] }));
}
