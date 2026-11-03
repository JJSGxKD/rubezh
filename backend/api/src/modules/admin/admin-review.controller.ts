import { Controller, Get, Inject, Query, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { REWARDED_VIDEO_PLACES } from "../ads/interstitial-gate.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { accountOf } from "../auth/auth.guard.js";
import { FlagsService } from "../flags/flags.service.js";
import { RolesService } from "../roles/roles.service.js";
import { FlagNotFoundError } from "./admin-errors.js";
import type { FlagSplit, FlagSplitGroup } from "../funnel/flag-split-report.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { RunsViewService } from "../runs/runs-view.service.js";
import type { ReviewRow } from "../runs/runs.repository.js";
import { FUNNEL_REPOSITORY, type FunnelRepository } from "../funnel/funnel.repository.js";
import type { FunnelMarked, FunnelRow } from "../funnel/funnel-report.js";
import { HIDDEN_KIND_PERMISSION } from "../restrictions/restriction-visibility.js";
import { BOARD_MARK_READER, type BoardMarkReader } from "./board-mark.reader.js";
import { parse, periodOf } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { flagSplitQuerySchema, periodQuerySchema, reviewLimitSchema } from "./dto/admin.dto.js";

/**
 * Очередь разбора забегов и воронка по источникам в панели
 * (docs/35-stage4-plan.md, WP17 п. 3 и 7). Оба раздела читают то, что уже
 * умеют модули забегов и воронки; панель лишь другой вход к тем же данным.
 * Там же — доля флага против остальных (WP12, часть 10b).
 */

/** Флаг для выбора в сравнении долей: что сравнивается и с какого момента доля стабильна. */
export interface SplitFlagView {
  key: string;
  enabled: boolean;
  platforms: PlatformId[];
  percent: number;
  note: string | null;
  updatedAt: string;
}

/** Доля в ответе панели: звёзды — доход, их видит только тот, у кого право на него. */
export type FlagSplitGroupView = Omit<FlagSplitGroup, "stars"> & { stars: FlagSplitGroup["stars"] | null };
export interface FlagSplitView {
  share: FlagSplitGroupView;
  rest: FlagSplitGroupView;
}

/** Флаг, выбранный по умолчанию: межстраничная — то, ради чего сравнение заведено. */
const DEFAULT_SPLIT_FLAG = "ads.interstitial";
const YEAR_MS = 365 * 86_400_000;

/**
 * Забег в очереди и чей он: разбирают человека, и без имени строка — только
 * uuid. `boardMarked` приходит держателю права `players.board.restrict` и
 * только ему (T-0115): у остальных ключа в строке нет.
 */
export type ReviewView = ReviewRow & { displayName: string | null; boardMarked?: boolean };
@Controller("admin")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminReviewController {
  constructor(
    private readonly runs: RunsViewService,
    @Inject(FUNNEL_REPOSITORY) private readonly funnel: FunnelRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly flags: FlagsService,
    private readonly roles: RolesService,
    @Inject(BOARD_MARK_READER) private readonly boardMarks: BoardMarkReader,
  ) {}

  /** Подозрительные и отклонённые забеги, свежие первыми. */
  @Get("runs/review")
  @RequirePermission("players.view")
  async review(@Req() request: unknown, @Query("limit") limit?: string): Promise<{ data: { runs: ReviewView[] } }> {
    const parsed = parse(() => reviewLimitSchema.parse(limit ?? undefined), "Некорректный предел");
    const runs = await this.runs.review(parsed);
    // Имена — одним запросом на всю очередь: игроков в ней меньше, чем забегов.
    const names = await this.accounts.displayNames([...new Set(runs.map((run) => run.accountId))]);
    const marked = (await this.roles.can(accountOf(request), HIDDEN_KIND_PERMISSION)) ? await this.markedIn(runs) : null;
    return {
      data: {
        runs: runs.map((run) => ({
          ...run,
          displayName: names.get(run.accountId) ?? null,
          ...(marked === null ? {} : { boardMarked: marked.has(run.accountId) }),
        })),
      },
    };
  }

  /**
   * Помеченные аккаунты за окно выборки — от самого раннего забега страницы до
   * самого позднего, одним запросом на всю страницу (T-0115). Забег без времени
   * конца — идущий: для него окно доходит до сейчас.
   */
  private async markedIn(runs: readonly ReviewRow[]): Promise<ReadonlySet<string>> {
    if (runs.length === 0) return new Set();
    const now = Date.now();
    const moments = runs.map((run) => run.finishedAt?.getTime() ?? now);
    const ids = await this.boardMarks.ids(new Date(Math.min(...moments)), new Date(Math.max(...moments) + 1));
    return new Set(ids);
  }

  /** Сколько аккаунтов дошло до каждой вехи — по площадке, виду и коду источника первого касания. */
  @Get("funnel")
  @RequirePermission("analytics.gameplay.view")
  async funnelReport(@Req() request: unknown, @Query() query: unknown): Promise<{ data: { from: string; to: string; rows: FunnelRow[]; marked?: FunnelMarked } }> {
    const period = periodOf(parse(() => periodQuerySchema.parse(query), "Некорректный период"), new Date());
    const [rows, canSee] = await Promise.all([this.funnel.report(period.from, period.to), this.roles.can(accountOf(request), HIDDEN_KIND_PERMISSION)]);
    const base = { from: period.from.toISOString(), to: period.to.toISOString(), rows };
    // Строка «Отдельная доска» — только держателю права: у остальных ответ прежний.
    return { data: canSee ? { ...base, marked: await this.boardMarks.funnel(period.from, period.to) } : base };
  }

  /**
   * Доля флага против остальных — по ней решают, оставить ли выкаченное.
   * Флаги — для выбора; без флагов в базе сравнивать нечего. Период по
   * умолчанию — с последнего изменения флага: до него доля была другой, и
   * сравнение смешало бы два выката. Число платящих видно, как в воронке, а
   * звёзды — только с правом `analytics.revenue.view`.
   */
  @Get("funnel/flag-split")
  @RequirePermission("analytics.gameplay.view")
  async flagSplit(
    @Req() request: unknown,
    @Query() query: unknown,
  ): Promise<{ data: { flags: SplitFlagView[]; flag: string | null; from: string | null; to: string | null; split: FlagSplitView | null } }> {
    const parsed = parse(() => flagSplitQuerySchema.parse(query), "Некорректный флаг или период");
    const flags = await this.flags.catalog();
    const views = flags.map(viewOfFlag);
    const key = parsed.flag ?? (flags.some((flag) => flag.key === DEFAULT_SPLIT_FLAG) ? DEFAULT_SPLIT_FLAG : flags[0]?.key);
    if (key === undefined) return { data: { flags: views, flag: null, from: null, to: null, split: null } };
    const rule = flags.find((flag) => flag.key === key);
    if (rule === undefined) throw new FlagNotFoundError();
    const now = new Date();
    const to = parsed.to ?? now;
    const from = parsed.from ?? new Date(Math.max(rule.updatedAt.getTime(), to.getTime() - YEAR_MS));
    const period = periodOf({ from, to }, now);
    const [split, revenue] = await Promise.all([this.funnel.flagSplit(rule, period.from, period.to, now, REWARDED_VIDEO_PLACES), this.roles.can(accountOf(request), "analytics.revenue.view")]);
    return { data: { flags: views, flag: key, from: period.from.toISOString(), to: period.to.toISOString(), split: revenue ? split : withoutRevenue(split) } };
  }
}

function viewOfFlag(flag: { key: string; enabled: boolean; platforms: readonly PlatformId[]; percent: number; note: string | null; updatedAt: Date }): SplitFlagView {
  return { key: flag.key, enabled: flag.enabled, platforms: [...flag.platforms], percent: flag.percent, note: flag.note, updatedAt: flag.updatedAt.toISOString() };
}

function withoutRevenue(split: FlagSplit): FlagSplitView {
  return { share: { ...split.share, stars: null }, rest: { ...split.rest, stars: null } };
}
