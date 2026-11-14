import { Injectable, Logger, Module } from "@nestjs/common";
import { withTimeout } from "./with-timeout.js";

/**
 * Что список показывает рядом с именем игрока (docs/35-stage4-plan.md Р149,
 * tasks/T-0240): сейчас — один выбранный знак, облик (T-0237) добавится в тот же
 * `PublicMark`. Рейтинг, таблица сезона и друзья берут его одним вызовом на весь
 * список и о том, откуда он, не знают: источник подключает модуль достижений сам,
 * как престиж забегов (`runs/run-prestige.ts`).
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
}

/** Метки пачки аккаунтов одним запросом; кого источник не назвал, у того меток нет. */
export interface PublicIdentitySource {
  of(accountIds: readonly string[]): Promise<ReadonlyMap<string, PublicMark>>;
}

@Injectable()
export class PublicIdentity {
  private readonly logger = new Logger("public-identity");
  private source: PublicIdentitySource | null = null;

  provide(source: PublicIdentitySource): void {
    this.source = source;
  }

  /**
   * Метки спрошенных аккаунтов. Нет источника, он сбойнул или не успел — пустая карта: строки
   * идут без знака, а таблица, список друзей и сезон отдаются. Знак — украшение, не причина
   * ронять список. Кого источник не назвал или назвал с битой записью — в карте нет.
   */
  async of(accountIds: readonly string[]): Promise<Map<string, PublicMark>> {
    const asked = [...new Set(accountIds)];
    if (this.source === null || asked.length === 0) return new Map();
    try {
      const found = await withTimeout(this.source.of(asked), PUBLIC_IDENTITY_TIMEOUT_MS, "знаки для списка");
      const marks = new Map<string, PublicMark>();
      for (const id of asked) {
        const mark = cleanMark(found.get(id));
        if (mark !== null) marks.set(id, mark);
      }
      return marks;
    } catch (error) {
      this.logger.warn(JSON.stringify({ module: "public-identity", event: "public_identity_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return new Map();
    }
  }
}

/**
 * Один порт на приложение: рейтинг, сезон, друзья и модуль достижений получают тот же
 * экземпляр, поэтому источник, подключённый достижениями, виден всем трём спискам.
 */
@Module({ providers: [PublicIdentity], exports: [PublicIdentity] })
export class PublicIdentityModule {}

/** Знак в строку списка: поля нет, если знака нет — строка остаётся такой же, как до знаков. */
export function emblemOf(mark: PublicMark | undefined): { emblem?: PublicEmblem } {
  return mark?.emblem === undefined ? {} : { emblem: mark.emblem };
}

/** Метка только с известными полями: лишнее от источника в ответ списка не уходит. */
function cleanMark(mark: PublicMark | undefined): PublicMark | null {
  const emblem = mark?.emblem;
  if (emblem === undefined) return mark === undefined ? null : {};
  if (typeof emblem.id !== "string" || typeof emblem.title !== "string" || typeof emblem.tier !== "string") return {};
  if (emblem.category !== "status" && emblem.category !== "season" && emblem.category !== "merit") return {};
  const season = Number.isInteger(emblem.season) && (emblem.season ?? 0) > 0 ? emblem.season : undefined;
  return { emblem: { id: emblem.id, title: emblem.title, tier: emblem.tier, category: emblem.category, ...(season === undefined ? {} : { season }) } };
}
