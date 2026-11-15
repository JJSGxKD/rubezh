import { Injectable, Logger, Module } from "@nestjs/common";
import { withTimeout } from "./with-timeout.js";

/**
 * Что список показывает рядом с именем игрока (docs/35-stage4-plan.md Р149, Р150,
 * tasks/T-0240, T-0237): выбранный знак, облик героя и выбор «голова облика или фото» в
 * кружке аватара — всё в одном `PublicMark`. Рейтинг, таблица сезона и друзья берут его
 * одним вызовом на весь список и о том, откуда он, не знают: источники подключают модули
 * достижений (знак) и обликов сами, как престиж забегов (`runs/run-prestige.ts`).
 *
 * Бэкенд пакеты клиента не импортирует, поэтому формы — зеркало `PublicEmblem` и
 * `PublicMark` из `packages/shared-types`: держать равными.
 */

/** Потолок ожидания источника: списки открывают часто, и ждать ради знака они не должны. */
export const PUBLIC_IDENTITY_TIMEOUT_MS = 1_000;

/** Знак у имени в строке списка. */
export interface PublicEmblem {
  id: string;
  title: string;
  tier: string;
  category: "status" | "season" | "merit";
  /** порядковый номер сезона — только у сезонного знака */
  season?: number;
}

export interface PublicMark {
  emblem?: PublicEmblem;
  /** действующий облик: выбранный, а если игрок им больше не владеет, — Хранитель */
  appearance?: string;
  /** в кружке аватара фото площадки, а не голова облика; поля нет — голова */
  avatarPhoto?: true;
}

/** Имена источников порта: повторное подключение под тем же именем заменяет источник. */
export const IDENTITY_SOURCES = { emblem: "emblem", appearance: "appearance" } as const;

/** Метки пачки аккаунтов одним запросом; кого источник не назвал, у того меток нет. */
export interface PublicIdentitySource {
  of(accountIds: readonly string[]): Promise<ReadonlyMap<string, PublicMark>>;
}

@Injectable()
export class PublicIdentity {
  private readonly logger = new Logger("public-identity");
  private readonly sources = new Map<string, PublicIdentitySource>();

  /**
   * Подключить источник меток под именем. Источников несколько (знак — модуль достижений, облик —
   * модуль обликов): у каждого свой сбой и свой таймаут, поэтому упавший не стирает метки
   * соседнего. Имя по умолчанию — знак: так модуль достижений подключился до обликов.
   */
  provide(source: PublicIdentitySource, name: string = IDENTITY_SOURCES.emblem): void {
    this.sources.set(name, source);
  }

  /**
   * Метки спрошенных аккаунтов. Нет источников, источник сбойнул или не успел — его меток нет:
   * строки идут без знака или без облика, а таблица, список друзей и сезон отдаются. Метки —
   * украшение, не причина ронять список. Кого источник не назвал или назвал с битой записью —
   * в карте нет.
   */
  async of(accountIds: readonly string[]): Promise<Map<string, PublicMark>> {
    const asked = [...new Set(accountIds)];
    const marks = new Map<string, PublicMark>();
    if (this.sources.size === 0 || asked.length === 0) return marks;
    const found = await Promise.all([...this.sources].map(async ([name, source]) => await this.ask(name, source, asked)));
    for (const part of found) {
      for (const [id, mark] of part) marks.set(id, { ...marks.get(id), ...mark });
    }
    return marks;
  }

  /** Один источник со своим таймаутом: сбой даёт пустую карту, а не исключение. */
  private async ask(name: string, source: PublicIdentitySource, asked: readonly string[]): Promise<Map<string, PublicMark>> {
    try {
      const found = await withTimeout(source.of(asked), PUBLIC_IDENTITY_TIMEOUT_MS, "метки для списка");
      const marks = new Map<string, PublicMark>();
      for (const id of asked) {
        const mark = cleanMark(found.get(id));
        if (mark !== null) marks.set(id, mark);
      }
      return marks;
    } catch (error) {
      this.logger.warn(JSON.stringify({ module: "public-identity", event: "public_identity_failed", source: name, reason: error instanceof Error ? error.message : "unknown" }));
      return new Map();
    }
  }
}

/**
 * Один порт на приложение: рейтинг, сезон, друзья и модули достижений и обликов получают тот же
 * экземпляр, поэтому источники, подключённые ими, видны всем трём спискам.
 */
@Module({ providers: [PublicIdentity], exports: [PublicIdentity] })
export class PublicIdentityModule {}

/**
 * Метки в строку списка: поля нет, если метки нет, — строка остаётся такой же, как до знаков
 * и обликов.
 */
export function markOf(mark: PublicMark | undefined): PublicMark {
  if (mark === undefined) return {};
  return {
    ...(mark.emblem === undefined ? {} : { emblem: mark.emblem }),
    ...(mark.appearance === undefined ? {} : { appearance: mark.appearance }),
    ...(mark.avatarPhoto === undefined ? {} : { avatarPhoto: mark.avatarPhoto }),
  };
}

/**
 * Метка только с известными полями: лишнее от источника в ответ списка не уходит. Каждое поле
 * чистится само — битый знак не уносит с собой облик из той же записи.
 */
function cleanMark(mark: PublicMark | undefined): PublicMark | null {
  if (mark === undefined) return null;
  const emblem = cleanEmblem(mark.emblem);
  return {
    ...(emblem === null ? {} : { emblem }),
    ...(typeof mark.appearance === "string" && mark.appearance !== "" ? { appearance: mark.appearance } : {}),
    ...(mark.avatarPhoto === true ? { avatarPhoto: true as const } : {}),
  };
}

function cleanEmblem(emblem: PublicEmblem | undefined): PublicEmblem | null {
  if (emblem === undefined) return null;
  if (typeof emblem.id !== "string" || typeof emblem.title !== "string" || typeof emblem.tier !== "string") return null;
  if (emblem.category !== "status" && emblem.category !== "season" && emblem.category !== "merit") return null;
  const season = Number.isInteger(emblem.season) && (emblem.season ?? 0) > 0 ? emblem.season : undefined;
  return { id: emblem.id, title: emblem.title, tier: emblem.tier, category: emblem.category, ...(season === undefined ? {} : { season }) };
}
