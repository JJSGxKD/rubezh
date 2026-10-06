import { Inject, Injectable } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { ADS_REPOSITORY, type AdsRepository } from "./ads.repository.js";

/** Ключи меняются из панели редко, а нужны на каждый шаг показа и каждый запуск бота. */
const KEYS_TTL_MS = 30_000;
const DB_TIMEOUT_MS = 3_000;

/**
 * Публичные ключи всех сетей — включённых и выключенных (Р78): SDK Taddy
 * учитывает аудиторию, пока задан `pubId`, даже у выключенной сети, а
 * отметка показа нужна и тогда, когда сеть выключили между выдачей и
 * показом. Выдача показа берёт ключи из блоков — там только включённые.
 */
@Injectable()
export class AdNetworkKeys {
  private cache: { keys: ReadonlyMap<string, Readonly<Record<string, string>>>; until: number } | null = null;

  constructor(@Inject(ADS_REPOSITORY) private readonly repository: AdsRepository) {}

  /** Ключи сети; `null` — сети нет в базе. */
  async of(networkKey: string): Promise<Readonly<Record<string, string>> | null> {
    return (await this.all()).get(networkKey) ?? null;
  }

  async all(): Promise<ReadonlyMap<string, Readonly<Record<string, string>>>> {
    const now = Date.now();
    if (this.cache === null || this.cache.until <= now) {
      const rows = await withTimeout(this.repository.networkKeys(), DB_TIMEOUT_MS, "ключи рекламных сетей");
      this.cache = { keys: new Map(rows.map((row) => [row.networkKey, row.keys])), until: now + KEYS_TTL_MS };
    }
    return this.cache.keys;
  }

  /** Ключи сети поменяли в панели — следующий шаг берёт свежие. */
  forget(): void {
    this.cache = null;
  }
}
