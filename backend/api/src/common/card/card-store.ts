import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";

/**
 * Хранилище готовых картинок бота по хэшу содержимого (docs/35-stage4-plan.md
 * Р156): у картинки появляется публичный адрес, и «Поделиться» несёт её
 * крупным предпросмотром, не загружая в Telegram.
 *
 * Адрес — SHA-256 самого PNG, поэтому он не угадывается и не содержит ни id
 * игрока, ни имени. Тот же PNG — тот же адрес: сохранение идемпотентно.
 */

/** Хэш в адресе: ровно 64 строчных шестнадцатеричных знака. */
export const CARD_HASH = /^[0-9a-f]{64}$/;

/** Сколько живёт картинка: предпросмотр отправленного сообщения открывают и через недели. */
export const CARD_STORE_TTL_SEC = 30 * 24 * 60 * 60;

/** Потолок размера: картинка 1200×675 весит сотни килобайт, а больше — не наша. */
export const CARD_MAX_BYTES = 4 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function cardHashOf(png: Buffer): string {
  return createHash("sha256").update(png).digest("hex");
}

export interface CardStore {
  /** Сохранить PNG и вернуть хэш — часть публичного адреса. */
  save(png: Buffer): Promise<string>;
  /** `null` — такой картинки нет: не сохраняли или срок вышел. */
  read(hash: string): Promise<Buffer | null>;
}

export const CARD_STORE = Symbol("CARD_STORE");

@Injectable()
export class RedisCardStore implements CardStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async save(png: Buffer): Promise<string> {
    if (png.length === 0 || png.length > CARD_MAX_BYTES) throw new Error(`Картинка бота: размер ${png.length} байт вне допустимого`);
    if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error("Картинка бота: это не PNG");
    const hash = cardHashOf(png);
    // Тот же PNG — тот же ключ: повтор только продлевает срок.
    await this.redis.set(`card:png:${hash}`, png, "EX", CARD_STORE_TTL_SEC);
    return hash;
  }

  async read(hash: string): Promise<Buffer | null> {
    if (!CARD_HASH.test(hash)) return null;
    return await this.redis.getBuffer(`card:png:${hash}`);
  }
}
