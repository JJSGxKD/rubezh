import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { dayWindow, teamDay, type DayStats } from "../admin-notify/daily-stats.js";
import { DAILY_STATS_REPOSITORY, type DailyStatsRepository, type DayPoint } from "../admin-notify/daily-stats.repository.js";
import { ADS_CATALOG_REPOSITORY, type AdFunnelRow, type AdPassRow, type AdsCatalogRepository } from "../ads/ads-catalog.repository.js";
import { AD_PLACES } from "../ads/ads-rules.js";
import { BroadcastsService } from "../broadcasts/broadcasts.service.js";
import { CHANGELOG_FOR_PLAYERS } from "../changelog/changelog-rules.js";
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
 * неполные сутки против полных показали бы падение каждое утро. Период —
 * сутки, 7 или 30 дней: последние N суток, сегодняшние включительно, против
 * предыдущих N суток той же длины, по той же причине.
 */

const DAY_MS = 86_400_000;
/** Не короче стольких суток на графике, вместе с сегодняшними; при периоде 30 дней — 30. */
export const OVERVIEW_DAYS = 14;
/** Периоды сводки, суток. */
export const OVERVIEW_PERIODS = [1, 7, 30] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];
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

/** Воронка показов за окно, сведённая до того, что нужно сводке. */
export interface AdsTotals {
  offered: number;
  shown: number;
  completed: number;
  claimed: number;
  failed: number;
  /** пропуски VIP (Р99): награда места без ролика; в досмотры, доли и сети не входят */
  passed: number;
}

/**
 * Реклама в сводке — та же воронка, что в разделе «Реклама». Денег от сетей в
 * базе нет, поэтому о деньгах рекламы сводка молчит, а не выдумывает.
 */
export interface OverviewAds {
  now: AdsTotals;
  before: AdsTotals;
  /** места показа — суммой по сетям, в порядке `AD_PLACES` */
  places: ({ place: string } & AdsTotals)[];
  /** досмотры по сетям, больше — выше */
  networks: { networkKey: string; completed: number }[];
}

export interface Overview {
  /** период: сутки, 7 или 30 дней */
  days: OverviewPeriod;
  /** сутки по Москве, `2026-10-01` */
  day: string;
  /** начало суток и момент среза — ISO */
  from: string;
  at: string;
  today: OverviewDay;
  /** вчера с полуночи до того же часа */
  yesterday: OverviewDay;
  /** звёзды и покупки — `null`, если выручка закрыта */
  series: (Omit<DayPoint, "stars" | "purchases"> & { stars: number | null; purchases: number | null })[];
  /** `null` — нет права `ads.view` или чтение не ответило */
  ads: OverviewAds | null;
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
    @Inject(ADS_CATALOG_REPOSITORY) private readonly ads: AdsCatalogRepository,
  ) {}

  async overview(actor: AccountRef, days: OverviewPeriod, now = new Date()): Promise<Overview> {
    await this.roles.require(actor, "analytics.gameplay.view");
    const can = permissionsOf(await this.roles.rolesFor(actor));
    const day = teamDay(now.getTime());
    const start = dayWindow(day).from;
    // Окно — от начала суток (days − 1) назад до сейчас; прошлое — то же, сдвинутое на период.
    const from = new Date(start.getTime() - (days - 1) * DAY_MS);
    const previousFrom = new Date(from.getTime() - days * DAY_MS);
    const previousTo = new Date(now.getTime() - days * DAY_MS);
    const seriesFrom = new Date(start.getTime() - (Math.max(OVERVIEW_DAYS, days) - 1) * DAY_MS);

    const [today, yesterday, series, ads, attention] = await Promise.all([
      withTimeout(this.stats.day({ day: teamDay(from.getTime()), from, to: now }), READ_TIMEOUT_MS, "сводка: сейчас"),
      withTimeout(this.stats.day({ day: teamDay(previousFrom.getTime()), from: previousFrom, to: previousTo }), READ_TIMEOUT_MS, "сводка: прошлый период"),
      withTimeout(this.stats.series(seriesFrom, now), READ_TIMEOUT_MS, "сводка: ряд"),
      can.has("ads.view") ? this.adsOverview({ from, to: now }, { from: previousFrom, to: previousTo }) : null,
      this.attention(actor, can, now),
    ]);
    const revenue = can.has("analytics.revenue.view");
    const shown = (stats: DayStats): OverviewDay => ({ ...stats, revenue: revenue ? stats.revenue : null });
    return {
      days,
      day,
      from: start.toISOString(),
      at: now.toISOString(),
      today: shown(today),
      yesterday: shown(yesterday),
      series: series.map((point) => ({ ...point, stars: revenue ? point.stars : null, purchases: revenue ? point.purchases : null })),
      ads,
      attention,
    };
  }

  /** Реклама за окно и за прошлое; не ответила — сводка без неё, а не без сводки. */
  private async adsOverview(now: { from: Date; to: Date }, before: { from: Date; to: Date }): Promise<OverviewAds | null> {
    try {
      const [current, previous, currentPasses, previousPasses] = await Promise.all([
        withTimeout(this.ads.funnel(now.from, now.to), READ_TIMEOUT_MS, "сводка: реклама"),
        withTimeout(this.ads.funnel(before.from, before.to), READ_TIMEOUT_MS, "сводка: реклама до"),
        withTimeout(this.ads.passes(now.from, now.to), READ_TIMEOUT_MS, "сводка: пропуски рекламы"),
        withTimeout(this.ads.passes(before.from, before.to), READ_TIMEOUT_MS, "сводка: пропуски рекламы до"),
      ]);
      return {
        now: totalsOf(current, currentPasses),
        before: totalsOf(previous, previousPasses),
        // Место входит, если по нему есть показы или пропуски.
        places: AD_PLACES.flatMap((place) => {
          const rows = current.filter((row) => row.place === place);
          const used = currentPasses.filter((pass) => pass.place === place);
          return rows.length === 0 && used.length === 0 ? [] : [{ place, ...totalsOf(rows, used) }];
        }),
        networks: networksOf(current),
      };
    } catch (error: unknown) {
      this.logger.warn(`сводка без рекламы: ${error instanceof Error ? error.message : "unknown"}`);
      return null;
    }
  }

  /**
   * Что ждёт того, кто смотрит, — по его правам: черновики «Что нового»
   * после выката видит тот, кто публикует, рассылки коллег — тот, кто
   * запускает. Источник, который не ответил, пропускается: сводка без
   * одной строки лучше, чем пустой экран.
   */
  private async attention(actor: AccountRef, can: ReadonlySet<Permission>, now: Date): Promise<AttentionItem[]> {
    const items = await Promise.all([
      // Журнал скрыт у игроков (Р125): черновики версий не напоминаются.
      CHANGELOG_FOR_PLAYERS && can.has("changelog.publish") ? this.safely("журнал обновлений", () => this.changelogDrafts(actor)) : null,
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

function totalsOf(rows: readonly AdFunnelRow[], passes: readonly AdPassRow[]): AdsTotals {
  const totals: AdsTotals = { offered: 0, shown: 0, completed: 0, claimed: 0, failed: 0, passed: 0 };
  for (const pass of passes) totals.passed += pass.used;
  for (const row of rows) {
    totals.offered += row.offered;
    totals.shown += row.shown;
    totals.completed += row.completed;
    totals.claimed += row.claimed;
    totals.failed += row.failed;
  }
  return totals;
}

/** Досмотры по сетям — суммой по местам, у кого больше, тот выше; при равенстве — по имени. */
function networksOf(rows: readonly AdFunnelRow[]): { networkKey: string; completed: number }[] {
  const byNetwork = new Map<string, number>();
  for (const row of rows) byNetwork.set(row.networkKey, (byNetwork.get(row.networkKey) ?? 0) + row.completed);
  return [...byNetwork].map(([networkKey, completed]) => ({ networkKey, completed })).sort((a, b) => b.completed - a.completed || a.networkKey.localeCompare(b.networkKey));
}
