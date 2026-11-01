import { Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";

/**
 * Престиж игроков для строк рейтинга (docs/39-retention-mechanics.md К1,
 * tasks/T-0107).
 *
 * Модуль забегов о достижениях не знает: источник подключает модуль
 * достижений сам, как модуль предметов — сверку снаряжения (`run-loadouts.ts`).
 * Иначе забегу понадобились бы достижения, а им — забеги, которые двигают
 * их прогресс.
 */

/** Потолок ожидания источника: рейтинг открывают часто, и ждать ради значка он не должен. */
export const PRESTIGE_TIMEOUT_MS = 1_000;

/** Престиж пачки аккаунтов одним запросом; кого источник не назвал, у того ноль. */
export interface PrestigeSource {
  of(accountIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

@Injectable()
export class RunPrestige {
  private readonly logger = new Logger("runs");
  private source: PrestigeSource | null = null;

  provide(source: PrestigeSource): void {
    this.source = source;
  }

  /**
   * Престиж каждого из `accountIds`: всегда запись на каждый id, ноль, если
   * источника нет, он сбойнул или не успел. Рейтинг без значков — деградация, а
   * не ошибка: таблица важнее украшения.
   */
  async of(accountIds: readonly string[]): Promise<Map<string, number>> {
    const zeros = new Map(accountIds.map((id) => [id, 0] as const));
    if (this.source === null || accountIds.length === 0) return zeros;
    try {
      const found = await withTimeout(this.source.of(accountIds), PRESTIGE_TIMEOUT_MS, "престиж для рейтинга");
      return new Map(accountIds.map((id) => [id, sane(found.get(id))] as const));
    } catch (error) {
      this.logger.warn(JSON.stringify({ module: "runs", event: "prestige_unavailable", reason: error instanceof Error ? error.message : "unknown" }));
      return zeros;
    }
  }
}

/** Престиж — неотрицательное целое; всё иное от источника — ноль, значок не рисуется. */
function sane(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
