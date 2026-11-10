import { randomBytes } from "node:crypto";
import type { RateLimit } from "../ingest/rate-limiter.js";
import type { PlatformId } from "../../platforms/ports/platform.js";

/**
 * Правила связи игрового аккаунта с аккаунтом MAX или VK (docs/35-stage4-plan.md
 * Р188, tasks/T-0377). Связь служит заданиям «подпишись через бота», а не
 * входу: площадки здесь только те, куда игра ходит за подпиской.
 */

/** Площадки, с которыми бывает связь: у Telegram игрок и так известен, веб-версия каналов не имеет. */
export const LINK_PLATFORMS = ["max", "vk"] as const satisfies readonly PlatformId[];
export type LinkPlatform = (typeof LINK_PLATFORMS)[number];

export function isLinkPlatform(platform: PlatformId): platform is LinkPlatform {
  return (LINK_PLATFORMS as readonly string[]).includes(platform);
}

/** Исход записи пары «площадка + id» за аккаунтом. */
export type LinkOutcome = "linked" | "already" | "taken";

/** Исход применения кода ботом: к исходам записи добавляется «код не найден или протух». */
export type ConsumeOutcome = LinkOutcome | "expired";

/** За каким аккаунтом и для какой площадки выдан код. */
export interface LinkTarget {
  accountId: string;
  platform: LinkPlatform;
}

/**
 * Код — 16 случайных знаков: 62^16 вариантов не перебрать за 30 минут жизни
 * кода, а выдача ограничена лимитом на аккаунт.
 */
export const LINK_CODE_LENGTH = 16;
export const LINK_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const LINK_CODE_PATTERN = /^[A-Za-z0-9]{16}$/;

/** Сколько живёт код, секунд. */
export const LINK_CODE_TTL_SEC = 1_800;

/** Не больше 10 кодов в час на аккаунт: с запасом на повторные нажатия, но не на перебор. */
export const LINK_START_LIMIT: RateLimit = { scope: "ext_link_start", limit: 10, windowSec: 3_600 };

/** Источник случайных байт — `node:crypto`; подменяется в тестах. */
export type RandomSource = (size: number) => Uint8Array;

/**
 * Байт от 248 и выше отбрасывается: 248 = 62 · 4, а остаток от деления
 * остальных восьми значений сделал бы первые знаки алфавита чаще прочих.
 */
const BYTE_LIMIT = 248;

export function newLinkCode(random: RandomSource = randomBytes): string {
  let code = "";
  while (code.length < LINK_CODE_LENGTH) {
    for (const byte of random(LINK_CODE_LENGTH * 2)) {
      if (byte >= BYTE_LIMIT) continue;
      code += LINK_CODE_ALPHABET.charAt(byte % LINK_CODE_ALPHABET.length);
      if (code.length === LINK_CODE_LENGTH) break;
    }
  }
  return code;
}
