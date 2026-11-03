import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { newLinkCode } from "./link-code.js";

/**
 * Автоисточники и сводка незнакомых ключей (Р116, docs/24-attribution-and-sharing.md §3.6).
 * Запрос к базе живёт здесь, а не в сервисе (docs/15-engineering-standards.md §2.3).
 */

/** Незнакомых ключей в сводке не больше: иначе перебор ключей наполнил бы таблицу мусором. */
export const UNKNOWN_KEYS_MAX = 200;

const DAY_MS = 86_400_000;
/**
 * Ожидание соединения и время транзакции: записи идут из задания очереди, а не из ответа игроку,
 * и под волной после поста в канале замок выстраивает их в очередь — двух секунд Prisma по
 * умолчанию на неё не хватает.
 */
const TRANSACTION = { maxWait: 10_000, timeout: 10_000 } as const;
/** Один замок на создание любого автоисточника: потолок считается по всем сразу. */
const SOURCE_LOCK = "link_auto_source";
const KEYS_LOCK = "start_param_key";

export interface AutoSourceInput {
  /** канонический набор известных пар: `src-…_cmp-…` */
  autoKey: string;
  source: string | null;
  campaign: string;
  medium: string | null;
  /** метка партнёра из `prt-…`: к карточке партнёра не привязана */
  partnerTag: string | null;
  platform: PlatformId;
  /** момент сессии: от него отсчитывается скользящее окно потолка */
  now: Date;
  /** сколько новых автоисточников допустимо за скользящие 24 часа; 0 — автосоздание выключено */
  cap: number;
}

/** Строка сводки незнакомых ключей: сколько раз встретился и когда впервые и в последний раз. */
export interface UnknownKeyRow {
  key: string;
  hits: number;
  firstAt: Date;
  lastAt: Date;
}

/** `existing` — источник с таким ключом уже есть (в том числе скрытый); `capped` — потолок суток. */
export type AutoSourceOutcome = "created" | "existing" | "capped";

export const AUTO_SOURCES_REPOSITORY = Symbol("AUTO_SOURCES_REPOSITORY");

export interface AutoSourcesRepository {
  /**
   * Завести источник по набору пар, если его ещё нет и потолок суток не исчерпан. Параллельные
   * первые игроки разных ссылок потолок не пробивают: создание идёт под общим замком.
   */
  ensure(input: AutoSourceInput): Promise<AutoSourceOutcome>;
  /**
   * Записать незнакомые ключи в сводку: счётчик растёт, «последний раз» не уходит назад. Новые ключи
   * добавляются, пока в сводке меньше `UNKNOWN_KEYS_MAX`; значений пар сводка не хранит.
   */
  noteUnknownKeys(keys: string[], now: Date): Promise<void>;
  /** Сводка для панели: по убыванию «последнего раза», не больше `UNKNOWN_KEYS_MAX`. */
  unknownKeys(): Promise<UnknownKeyRow[]>;
}

@Injectable()
export class PrismaAutoSourcesRepository implements AutoSourcesRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async ensure(input: AutoSourceInput): Promise<AutoSourceOutcome> {
    // Нуль — автосоздание выключено, и базу такая сессия не трогает вовсе: выключатель нужен,
    // когда по ссылкам с метками идёт мусорная волна.
    if (input.cap <= 0) return "capped";
    // Заведённый ключ — без замка: волна запусков по одной ссылке не должна стоять в очереди за ним.
    if (await this.exists(input.autoKey)) return "existing";

    return await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SOURCE_LOCK}))`;
      // Тот же ключ мог завестись, пока мы ждали замок.
      if ((await tx.link.findUnique({ where: { autoKey: input.autoKey }, select: { code: true } })) !== null) return "existing";

      const since = new Date(input.now.getTime() - DAY_MS);
      const recent = await tx.link.count({ where: { auto: true, createdAt: { gt: since } } });
      if (recent >= input.cap) return "capped";

      await tx.link.create({
        data: {
          code: newLinkCode(),
          platform: input.platform,
          campaign: input.campaign,
          source: input.source,
          medium: input.medium,
          partnerTag: input.partnerTag,
          target: "app",
          network: null,
          createdBy: null,
          createdAt: input.now,
          auto: true,
          autoKey: input.autoKey,
        },
      });
      return "created";
    }, TRANSACTION);
  }

  async noteUnknownKeys(keys: string[], now: Date): Promise<void> {
    if (keys.length === 0) return;
    // Известные ключи считаются без замка: так обновляется почти каждый запрос.
    const updated = await this.prisma.$queryRaw<{ key: string }[]>`
      UPDATE start_param_key SET hits = hits + 1, last_at = GREATEST(last_at, ${now})
      WHERE key IN (${Prisma.join(keys)})
      RETURNING key`;
    const counted = new Set(updated.map((row) => row.key));
    const fresh = keys.filter((key) => !counted.has(key));
    if (fresh.length === 0) return;

    // Новые ключи — под замком: без него параллельные запуски перешагнули бы потолок.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${KEYS_LOCK}))`;
      for (const key of fresh) {
        // Ключ мог появиться, пока мы ждали замок, — тогда это просто ещё одно попадание.
        await tx.$executeRaw`
          INSERT INTO start_param_key (key, hits, first_at, last_at)
          SELECT ${key}::varchar, 1, ${now}::timestamptz, ${now}::timestamptz
          WHERE (SELECT count(*) FROM start_param_key) < ${UNKNOWN_KEYS_MAX}
          ON CONFLICT (key) DO UPDATE SET hits = start_param_key.hits + 1, last_at = GREATEST(start_param_key.last_at, EXCLUDED.last_at)`;
      }
    }, TRANSACTION);
  }

  async unknownKeys(limit = UNKNOWN_KEYS_MAX): Promise<UnknownKeyRow[]> {
    const rows = await this.prisma.startParamKey.findMany({ orderBy: [{ lastAt: "desc" }, { key: "asc" }], take: Math.min(limit, UNKNOWN_KEYS_MAX) });
    return rows.map(({ key, hits, firstAt, lastAt }) => ({ key, hits, firstAt, lastAt }));
  }

  private async exists(autoKey: string): Promise<boolean> {
    return (await this.prisma.link.findUnique({ where: { autoKey }, select: { code: true } })) !== null;
  }
}
