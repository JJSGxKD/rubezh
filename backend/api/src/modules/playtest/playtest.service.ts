import { Inject, Injectable } from "@nestjs/common";
import { DomainError, UnavailableError } from "../../common/domain-error.js";
import type { SessionReport } from "./dto/session-report.dto.js";
import { PLAYTEST_STATS_STORE, type PlaytestStatsStore } from "./playtest-stats.store.js";

/**
 * Отчёты о запуске для сводки плейтеста: сколько людей открыли игру и на чём
 * (docs/26-stage2-plan.md, WP14). Забеги, рейтинг и профиль живут в модуле
 * `runs` (docs/34-stage3-plan.md, WP4); здесь осталось то, что к забегам не
 * относится и уйдёт в сессии WP6.
 *
 * Сервис не знает об HTTP: контроллер разбирает запрос, фильтр переводит
 * ошибки в ответ (docs/15-engineering-standards.md §2.3).
 */
@Injectable()
export class PlaytestService {
  constructor(@Inject(PLAYTEST_STATS_STORE) private readonly statsStore: PlaytestStatsStore) {}

  /**
   * Недоступный Redis — не «внутренняя ошибка», а понятный ответ: пропущенный
   * запуск статистику не исказит, и клиент его не повторяет.
   */
  async recordSession(accountId: string, report: SessionReport, nowMs: number): Promise<void> {
    try {
      await this.statsStore.recordSession(accountId, report, nowMs);
    } catch (error: unknown) {
      if (error instanceof DomainError) throw error;
      throw new UnavailableError("Хранилище плейтеста недоступно, попробуйте позже");
    }
  }
}
