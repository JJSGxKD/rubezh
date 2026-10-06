import { createHash } from "node:crypto";
import type { PlatformId } from "../../platforms/ports/platform.js";

/**
 * Вычисление флага для игрока (docs/09-ci-cd.md §11). Доля выката
 * устойчивая: корзина — хэш пары «флаг + аккаунт», и игрок, попавший в 10 %,
 * остаётся в них и при 20 %. Ключ флага в хэше нужен, чтобы в раннюю долю
 * каждого флага попадали разные игроки, а не одни и те же «подопытные».
 */

export interface FlagRule {
  key: string;
  enabled: boolean;
  /** пусто — все площадки */
  platforms: readonly PlatformId[];
  /** 0–100 */
  percent: number;
}

export const FLAG_KEY = /^[a-z][a-z0-9_.-]{1,63}$/;

/** Корзина игрока для флага: 0–99, одна и та же при каждом вычислении. */
export function bucketOf(key: string, accountId: string): number {
  return createHash("sha256").update(`${key}:${accountId}`).digest().readUInt32BE(0) % 100;
}

export function isOn(rule: FlagRule, account: { accountId: string; platform: PlatformId }): boolean {
  if (!rule.enabled) return false;
  if (rule.platforms.length > 0 && !rule.platforms.includes(account.platform)) return false;
  return bucketOf(rule.key, account.accountId) < rule.percent;
}
