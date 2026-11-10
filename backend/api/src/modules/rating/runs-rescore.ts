import type { RunScoresRepository } from "./run-scores.repository.js";
import type { RunScorer } from "./run-scorer.service.js";
import type { StoredScore } from "./score-types.js";

/**
 * Пересчёт очков прошлых забегов (tasks/T-0293): после правки весов, показателя
 * Стойкости или таблицы ожидаемого. Идёт по сохранённым колонкам строки,
 * пачками по ключу, и **идемпотентен**: очки — функция строки и настроек,
 * поэтому второй прогон с теми же настройками записывает те же числа.
 *
 * Вердикт и рейтинг не трогает: подозрение `axis_out_of_range` ставится при
 * записи забега, а доски по очкам строит их собственный пересчёт (T-0294).
 */

export interface RescoreOptions {
  /** считать только забеги, законченные не раньше этой даты; `null` — все рейтинговые */
  since: Date | null;
  batchSize: number;
  /** считать только забеги без очков: так досчитывает при старте сервис, не трогая посчитанные */
  onlyUnscored?: boolean;
  log?: (message: string) => void;
}

export interface RescoreReport {
  scanned: number;
  rescored: number;
  /** подсчёт не вышел (таблица не загрузилась): очки забега остались прежними */
  unscored: number;
}

export async function rescoreRuns(repository: RunScoresRepository, scorer: RunScorer, options: RescoreOptions): Promise<RescoreReport> {
  const report: RescoreReport = { scanned: 0, rescored: 0, unscored: 0 };
  let after: string | null = null;
  for (;;) {
    const rows = await repository.page(after, options.since, options.batchSize, options.onlyUnscored ?? false);
    if (rows.length === 0) break;
    const scores: { runId: string; score: StoredScore }[] = [];
    for (const row of rows) {
      const scored = scorer.score({
        survivalSec: row.survivalSec,
        enemiesKilled: row.enemiesKilled,
        damageTaken: row.damageTaken,
        huntLog: row.scoreInput?.huntLog ?? null,
        buildScore: row.scoreInput?.buildScore ?? null,
        power: row.scoreInput?.power ?? null,
        contentHash: row.contentHash,
      });
      if (scored === null) {
        report.unscored += 1;
        continue;
      }
      scores.push({ runId: row.runId, score: { points: scored.points, axes: scored.axes, style: scored.style, band: scored.band } });
    }
    await repository.save(scores);
    report.scanned += rows.length;
    report.rescored += scores.length;
    after = rows[rows.length - 1]?.runId ?? null;
    options.log?.(`пересчитано ${String(report.rescored)} из ${String(report.scanned)}`);
  }
  return report;
}
