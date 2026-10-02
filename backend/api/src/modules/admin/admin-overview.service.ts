import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { dayWindow, previousDay, teamDay, type DayStats } from "../admin-notify/daily-stats.js";
import { DAILY_STATS_REPOSITORY, type DailyStatsRepository, type DayPoint } from "../admin-notify/daily-stats.repository.js";
import { BroadcastsService } from "../broadcasts/broadcasts.service.js";
import { ChangelogService } from "../changelog/changelog.service.js";
import { permissionsOf, type Permission } from "../roles/permissions.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { RunsViewService } from "../runs/runs-view.service.js";

/**
 * Сводка — первый экран панели (docs/29-admin-panel.md §5.2, дашборд Live):
 * что с игрой сегодня против вчера к тому же часу, две недели по суткам и
 * что ждёт действия того, кто смотрит. Цифры — те же запросы, что
 * ежедневный отчёт в чат: сводка и отчёт не расходятся.
 *
 * Сегодня сравнивается со вчера к тому же часу, а не со вчера целиком:
 * неполные сутки против полных показали бы падение каждое утро.
 */

const DAY_MS = 86_400_000;
/** Сколько суток на графике, вместе с сегодняшними. */
export const OVERVIEW_DAYS = 14;
const READ_TIMEOUT_MS = 15_000;
/** Сколько последних забегов очереди смотреть, считая новые за сутки. */
const REVIEW_SCAN = 200;

/** Сутки для сводки: выручка — только тому, кому она открыта. */
export type OverviewDay = Omit<DayStats, "revenue"> & { revenue: DayStats["revenue"] | null };

/** Что ждёт действия: раздел, сколько и что сделать — словами. */
export interface AttentionItem {
  section: string;
  count: number;
  text: string;
}

export interface Overview {
  /** сутки по Москве, `2026-10-01` */
  day: string;
  /** начало суток и момент среза — ISO */
  from: string;
  at: string;
  today: OverviewDay;
  /** вчера с полуночи до того же часа */
  yesterday: OverviewDay;
  /** звёзды — `null`, если выручка закрыта */
  series: (Omit<DayPoint, "stars"> & { stars: number | null })[];
  attention: AttentionItem[];
}

@Injectable()
export class AdminOverviewService {
  private readonly logger = new Logger("admin-overview");

  constructor(
    @Inject(DAILY_STATS_REPOSITORY) private readonly stats: DailyStatsRepository,
    private readonly roles: RolesService,
    private readonly changelog: ChangelogService,
    private readonly broadcasts: BroadcastsService,
    private readonly runs: RunsViewService,
  ) {}

  async overview(actor: AccountRef, now = new Date()): Promise<Overview> {
    await this.roles.require(actor, "analytics.gameplay.view");
    const can = permissionsOf(await this.roles.rolesFor(actor));
    const day = teamDay(now.getTime());
    const start = dayWindow(day).from;
    const elapsed = now.getTime() - start.getTime();
    const yesterdayFrom = new Date(start.getTime() - DAY_MS);

    const [today, yesterday, series, attention] = await Promise.all([
      withTimeout(this.stats.day({ day, from: start, to: now }), READ_TIMEOUT_MS, "сводка: сегодня"),
      withTimeout(this.stats.day({ day: previousDay(day), from: yesterdayFrom, to: new Date(yesterdayFrom.getTime() + elapsed) }), READ_TIMEOUT_MS, "сводка: вчера"),
      withTimeout(this.stats.series(new Date(start.getTime() - (OVERVIEW_DAYS - 1) * DAY_MS), now), READ_TIMEOUT_MS, "сводка: ряд"),
      this.attention(actor, can, now),
    ]);
    const revenue = can.has("analytics.revenue.view");
    const shown = (stats: DayStats): OverviewDay => ({ ...stats, revenue: revenue ? stats.revenue : null });
    return {
      day,
      from: start.toISOString(),
      at: now.toISOString(),
      today: shown(today),
      yesterday: shown(yesterday),
      series: series.map((point) => ({ ...point, stars: revenue ? point.stars : null })),
      attention,
    };
  }

  /**
   * Что ждёт того, кто смотрит, — по его правам: черновики «Что нового»
   * после выката видит тот, кто публикует, рассылки коллег — тот, кто
   * запускает. Источник, который не ответил, пропускается: сводка без
   * одной строки лучше, чем пустой экран.
   */
  private async attention(actor: AccountRef, can: ReadonlySet<Permission>, now: Date): Promise<AttentionItem[]> {
    const items = await Promise.all([
      can.has("changelog.publish") ? this.safely("журнал обновлений", () => this.changelogDrafts(actor)) : null,
      can.has("broadcast.send") ? this.safely("рассылки", () => this.broadcastDrafts(actor)) : null,
      can.has("players.view") ? this.safely("разбор забегов", () => this.freshReview(now)) : null,
    ]);
    return items.filter((item): item is AttentionItem => item !== null && item.count > 0);
  }

  private async changelogDrafts(actor: AccountRef): Promise<AttentionItem> {
    const { entries } = await withTimeout(this.changelog.list(actor), READ_TIMEOUT_MS, "сводка: журнал обновлений");
    const versions = [...new Set(entries.filter((entry) => entry.publishedAt === null).map((entry) => entry.version))];
    const named = versions.slice(0, 3).join(", ") + (versions.length > 3 ? " и ещё" : "");
    return { section: "changelog", count: versions.length, text: `«Что нового» ждёт публикации — ${versions.length === 1 ? "версия" : "версии"} ${named}` };
  }

  private async broadcastDrafts(actor: AccountRef): Promise<AttentionItem> {
    const all = await withTimeout(this.broadcasts.list(actor), READ_TIMEOUT_MS, "сводка: рассылки");
    // Свой черновик человек помнит сам; ждут его — черновики коллег.
    const drafts = all.filter((broadcast) => broadcast.status === "draft" && broadcast.createdBy !== actor.accountId);
    return { section: "broadcasts", count: drafts.length, text: `Рассылки коллег в черновиках — проверить, одобрить и запустить: ${String(drafts.length)}` };
  }

  private async freshReview(now: Date): Promise<AttentionItem> {
    const queue = await withTimeout(this.runs.review(REVIEW_SCAN), READ_TIMEOUT_MS, "сводка: разбор");
    const since = now.getTime() - DAY_MS;
    const fresh = queue.filter((run) => run.finishedAt !== null && run.finishedAt.getTime() >= since);
    return { section: "review", count: fresh.length, text: `Забегов на разбор за сутки: ${String(fresh.length)}` };
  }

  private async safely(source: string, read: () => Promise<AttentionItem>): Promise<AttentionItem | null> {
    try {
      return await read();
    } catch (error: unknown) {
      this.logger.warn(`сводка без строки «${source}»: ${error instanceof Error ? error.message : "unknown"}`);
      return null;
    }
  }
}
