import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import { isRatedRun } from "../runs/rated-runs.js";
import { RunsHooks, type RecordedRun } from "../runs/runs-hooks.js";
import { SeasonSchedule } from "../seasons/seasons-schedule.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import type { FeedEvent, FeedEventView, FeedView } from "./feed-events.js";
import { FEED_WINDOW_MS, feedEventsOf, isFeedRun, visibleEvents } from "./feed-rules.js";
import { FEED_REPOSITORY, type FeedRepository } from "./feed.repository.js";

/**
 * Лента живых событий (Р114, docs/35-stage4-plan.md; tasks/T-0174).
 *
 * Запись: слушатель `RunsHooks.onRecorded` — база не сканируется, событие
 * ложится в Redis при первой записи забега. Чтение: готовый ответ держится в
 * памяти реплики, пересчёт один за раз, а игрок на запрос не ходит ни в
 * Postgres, ни в Redis.
 *
 * Скрытые игроки отсеиваются при чтении, а не при записи: ограничение,
 * наложенное в течение суток, убирает уже записанные события. Имя в событие не
 * копируется — переименование модератором видно в ленте сразу.
 */

/** Ответ держится в памяти реплики столько, сколько длится окно, в котором лента не должна идти в источники. */
const CACHE_TTL_MS = 30_000;
/** После сбоя пересчёта прежний ответ держится недолго: упавший источник не должен получать удар от каждого запроса. */
const ERROR_HOLD_MS = 5_000;
/** Потолок прочитанных событий: выдача не растёт с нагрузкой. */
const RECENT_CAP = 500;
/** Не чаще одной строки в лог в минуту: сбой Redis под нагрузкой иначе утопил бы журнал. */
const WARN_INTERVAL_MS = 60_000;

@Injectable()
export class FeedService implements OnModuleInit {
  private readonly logger = new Logger("feed");
  private lastWarnAt = Number.NEGATIVE_INFINITY;
  private cached: { view: FeedView; until: number } | null = null;
  private inflight: Promise<FeedView> | null = null;

  constructor(
    @Inject(FEED_REPOSITORY) private readonly repository: FeedRepository,
    private readonly schedule: SeasonSchedule,
    private readonly hooks: RunsHooks,
    private readonly restrictions: AccountRestrictions,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  onModuleInit(): void {
    this.hooks.onRecorded("feed", async (run) => await this.recorded(run));
  }

  /**
   * Забег записан. Любая ошибка — одна строка `warn` в минуту: лента — витрина, и
   * забег от неё страдать не должен.
   */
  async recorded(run: RecordedRun): Promise<void> {
    try {
      if (!isFeedRun(run) || !isRatedRun(run.difficulty, run.finishedAt, this.schedule.ratingSince())) return;
      const weekRecord = await this.beatsWeekTop(run);
      const events = feedEventsOf(run, { longRunSec: this.settings.get(SETTINGS.feedLongRunSec) }, weekRecord);
      await this.repository.add(events, Date.now());
    } catch (error: unknown) {
      this.warn("record_failed", error);
    }
  }

  /**
   * Готовая лента. Не старше 30 с; параллельные запросы ждут один пересчёт.
   * Ошибка пересчёта не доходит до игрока: прежний ответ, если он есть, иначе
   * пустая лента.
   */
  view(now: Date): Promise<FeedView> {
    if (this.cached !== null && now.getTime() < this.cached.until) return Promise.resolve(this.cached.view);
    if (this.inflight !== null) return this.inflight;
    const pending = this.rebuild(now).finally(() => {
      this.inflight = null;
    });
    this.inflight = pending;
    return pending;
  }

  /** Забыть готовый ответ этой реплики: следующий запрос пересчитает ленту. */
  dropCache(): void {
    this.cached = null;
  }

  /** Обошёл ли забег лидера таблицы недели; сезонов нет — рекордов нет. */
  private async beatsWeekTop(run: RecordedRun): Promise<boolean> {
    const season = this.schedule.current(run.finishedAt);
    if (season === null) return false;
    const previous = await this.repository.bumpWeekTop(season.key, run.difficulty, run.survivalSec);
    // Первый забег недели на пустой таблице (-1) рекордом не считается.
    return previous > 0 && run.survivalSec > previous;
  }

  private async rebuild(now: Date): Promise<FeedView> {
    try {
      const view = await this.compose(now);
      this.cached = { view, until: now.getTime() + CACHE_TTL_MS };
      return view;
    } catch (error: unknown) {
      this.warn("view_failed", error);
      const view = this.cached?.view ?? { events: [], refreshSec: this.settings.get(SETTINGS.feedRefreshSec) };
      this.cached = { view, until: now.getTime() + ERROR_HOLD_MS };
      return view;
    }
  }

  private async compose(now: Date): Promise<FeedView> {
    const nowMs = now.getTime();
    const { events, skipped } = await this.repository.recent(nowMs - FEED_WINDOW_MS, RECENT_CAP);
    if (skipped > 0) this.warn("bad_record", undefined, { skipped });
    // Рейтинг исключает игрока двумя путями: закрытый рейтинг с блокировкой и скрытая отдельная доска.
    // Ленту читают все, сводной доски «по зрителю» у неё нет — поэтому не видны оба вида.
    const [closed, apart] = await Promise.all([this.restrictions.restrictedAccounts("leaderboard", now), this.restrictions.restrictedAccounts("separate_board", now)]);
    const shown = visibleEvents(events, {
      nowMs,
      hidden: new Set([...closed, ...apart]),
      perPlayer: this.settings.get(SETTINGS.feedPerPlayer),
      limit: this.settings.get(SETTINGS.feedMaxShown),
    });
    const names = await this.repository.namesOf([...new Set(shown.map((event) => event.accountId))]);
    return { events: shown.flatMap((event) => viewOf(event, names)), refreshSec: this.settings.get(SETTINGS.feedRefreshSec) };
  }

  private warn(event: string, error?: unknown, extra: Record<string, unknown> = {}): void {
    const nowMs = Date.now();
    if (nowMs - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = nowMs;
    const reason = error === undefined ? {} : { reason: error instanceof Error ? error.message : "unknown" };
    this.logger.warn(JSON.stringify({ module: "feed", event, ...reason, ...extra }));
  }
}

/** Событие без имени (аккаунт заблокирован или удалён) в ленту не идёт. */
function viewOf(event: FeedEvent, names: ReadonlyMap<string, string>): FeedEventView[] {
  const name = names.get(event.accountId);
  if (name === undefined) return [];
  // Сырой id содержит id забега: клиенту нужен только ключ строки.
  const id = createHash("sha1").update(event.id).digest("hex").slice(0, 12);
  return [{ id, kind: event.kind, name, at: new Date(event.atMs).toISOString(), seconds: event.seconds }];
}
