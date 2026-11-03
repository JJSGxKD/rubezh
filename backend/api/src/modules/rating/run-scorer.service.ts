import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { EVENT_DICTIONARY } from "../events/event-dictionary.js";
import type { EventRow } from "../events/events.repository.js";
import { EVENTS_SINK, type EventsSink } from "../events/events.sink.js";
import type { AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { bandOf, EXPECTED_TABLE_SOURCE, expectedRowOf, type ExpectedTableSource } from "./expected-table.js";
import { type RunScoreView } from "./score-types.js";
import {
  AXIS_IDS,
  axisIndexes,
  expectedPointsOf,
  isOutOfRange,
  minuteOf,
  normalizeWeights,
  pointsOf,
  roundIndex,
  styleOf,
  type AxisValues,
  type ScoreInput,
  type ScoreParams,
} from "./score-rules.js";

/**
 * Очки эффективности записанного забега (tasks/T-0293, Р66, Р152). Сервис
 * собирает правила (`score-rules.ts`), таблицу ожидаемого и ключи панели
 * `rating.*` и отдаёт готовое: очки, оси, стиль, полосу и ожидаемые очки.
 *
 * **Сбой подсчёта забегу не мешает.** Таблица не загрузилась, ключ панели
 * вышел из схемы, правило упало — `score` отвечает `null`, а запись забега
 * идёт как шла: очки можно досчитать командой `runs:rescore`, потерянный
 * забег — нет.
 */

/** Что нужно подсчёту: числа забега плюс то, чем выбирается строка таблицы. */
export interface RunScoreInput extends ScoreInput {
  /** сила игрока на старте забега; `null` — подстройки не было, полоса средняя */
  power: number | null;
  /** хэш контента забега: по нему видно, что таблица отстала */
  contentHash: string;
}

export type { RunScoreView, StoredScore } from "./score-types.js";

export interface ScoredRun extends RunScoreView {
  /** индекс любой оси выше двойного потолка — подозрение антифрода, а не очки */
  outOfRange: boolean;
}

/** Часы и вывод предупреждений — подменяются в тестах. */
export interface ScorerEnvironment {
  now(): number;
  warn(message: string): void;
}

export const SCORER_ENVIRONMENT = Symbol("SCORER_ENVIRONMENT");

/** Одно и то же предупреждение — не чаще раза в час: оно повторилось бы на каждом забеге. */
const WARN_INTERVAL_MS = 3_600_000;
/** Сколько ждать постановки серверного события в очередь. */
const EVENT_TIMEOUT_MS = 2_000;

/** Установка серверного события: конверт события привязан к устройству, у сервера оно одно. */
const SERVER_INSTALL_ID = "server";

@Injectable()
export class RunScorer {
  private readonly logger = new Logger("rating");
  private readonly lastWarnedAt = new Map<string, number>();
  private readonly environment: ScorerEnvironment;

  constructor(
    @Inject(EXPECTED_TABLE_SOURCE) private readonly source: ExpectedTableSource,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Optional() @Inject(EVENTS_SINK) private readonly sink: EventsSink | null = null,
    @Optional() @Inject(SCORER_ENVIRONMENT) environment?: ScorerEnvironment,
  ) {
    this.environment = environment ?? { now: () => Date.now(), warn: (message) => this.logger.warn(message) };
  }

  /** Посчитать забег; `null` — не получилось, причина в логе. */
  score(input: RunScoreInput): ScoredRun | null {
    try {
      const table = this.source.get();
      if (table === null) {
        this.warnOnce("table_missing", {});
        return null;
      }
      if (table.contentHash !== input.contentHash) this.warnOnce("table_stale", { tableHash: table.contentHash });
      const band = bandOf(table, input.power);
      const row = expectedRowOf(table, band.id, minuteOf(input.survivalSec));
      const params = this.params();
      const indexes = axisIndexes(input, row, params);
      const rounded: AxisValues = { t: roundIndex(indexes.t), k: roundIndex(indexes.k), h: roundIndex(indexes.h), c: roundIndex(indexes.c), b: roundIndex(indexes.b) };
      return {
        points: pointsOf(indexes, params),
        axes: rounded,
        style: styleOf(indexes, params),
        band: band.id,
        expectedPoints: expectedPointsOf(rounded.t, params),
        outOfRange: isOutOfRange(indexes, params.cap),
      };
    } catch (error: unknown) {
      this.logger.error(JSON.stringify({ module: "rating", event: "score_failed", reason: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  }

  /**
   * Ожидаемые очки по сохранённому индексу Стойкости: повтор итога отвечает
   * теми же числами, не обращаясь к таблице.
   */
  expectedPointsFor(enduranceIndex: number): number {
    return expectedPointsOf(enduranceIndex, this.params());
  }

  /**
   * Серверное событие `run_scored` (docs/22-analytics-and-metrics.md §3.3).
   * Падение писателя забегу не мешает: событие — аналитика, а не запись.
   * В полезной нагрузке нет идентификатора игрока, только забег.
   */
  async announce(account: AccountRef, runId: string, scored: RunScoreView): Promise<void> {
    if (this.sink === null) return;
    try {
      const payload = EVENT_DICTIONARY.run_scored.payload.parse({
        runId,
        points: scored.points,
        endurance: scored.axes.t,
        onslaught: scored.axes.k,
        hunt: scored.axes.h,
        clean: scored.axes.c,
        build: scored.axes.b,
        style: scored.style,
        strengthBand: scored.band,
      });
      const at = new Date(this.environment.now()).toISOString();
      const row: EventRow = {
        eventId: randomUUID(),
        eventType: "run_scored",
        schemaVersion: EVENT_DICTIONARY.run_scored.version,
        installId: SERVER_INSTALL_ID,
        platformUserId: null,
        sessionId: runId.slice(0, 64),
        platform: account.platform,
        appVersion: "server",
        payload,
        occurredAt: at,
        receivedAt: at,
      };
      await withTimeout(this.sink.write([row]), EVENT_TIMEOUT_MS, "событие очков");
    } catch (error: unknown) {
      this.warnOnce("event_failed", { reason: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Параметры подсчёта из панели: веса — проценты, показатель — сотые. */
  private params(): ScoreParams {
    const raw: AxisValues = {
      t: this.settings.get(SETTINGS.ratingWeightEndurance) / 100,
      k: this.settings.get(SETTINGS.ratingWeightOnslaught) / 100,
      h: this.settings.get(SETTINGS.ratingWeightHunt) / 100,
      c: this.settings.get(SETTINGS.ratingWeightClean) / 100,
      b: this.settings.get(SETTINGS.ratingWeightBuild) / 100,
    };
    const { weights, normalized } = normalizeWeights(raw);
    if (normalized) this.warnOnce("weights_normalized", { sumPercent: Math.round(AXIS_IDS.reduce((sum, axis) => sum + raw[axis], 0) * 100) });
    return {
      weights,
      enduranceExponent: this.settings.get(SETTINGS.ratingEnduranceExponent) / 100,
      cap: this.settings.get(SETTINGS.ratingIndexCap),
    };
  }

  private warnOnce(event: string, fields: Record<string, unknown>): void {
    const now = this.environment.now();
    const last = this.lastWarnedAt.get(event);
    if (last !== undefined && now - last < WARN_INTERVAL_MS) return;
    this.lastWarnedAt.set(event, now);
    this.environment.warn(JSON.stringify({ module: "rating", event, ...fields }));
  }
}
