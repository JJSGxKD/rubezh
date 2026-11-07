import { Inject, Injectable } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { ratedWhere, ratingSinceOf } from "../runs/rated-runs.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { storedAxesSchema } from "./score-types.js";
import { AXIS_IDS, roundIndex, type AxisId, type AxisValues } from "./score-rules.js";

/**
 * Стиль игрока (tasks/T-0295, Р152, `design/art/meta-v2.md` §2.4) в двух видах.
 *
 * **Стиль у имени** — `style` лучшего по очкам забега окна (текущего сезона), а
 * когда в окне забегов нет — лучшего за всё время. Нет забегов с очками — стиля
 * нет, игрока нет и в ответе. Читается пачкой на страницу, а не по одному.
 *
 * **«Твой стиль»** — среднее индексов пяти осей по последним десяти рейтинговым
 * забегам, каждый индекс срезан потолком очков (`rating.index-cap`): сильная
 * ось — с наибольшим средним, слабая — с наименьшим. Меньше трёх забегов —
 * стиля нет, ответ говорит, сколько сыграть ещё. Сервер отдаёт только ось;
 * подсказку к слабой оси (`rating.hint.<ось>`) подбирает клиент.
 */

/** Сколько последних рейтинговых забегов идёт в «Твой стиль». */
export const STYLE_RUNS = 10;
/** С скольких забегов стиль считается: на одном-двух выбросы решали бы всё. */
export const MIN_STYLE_RUNS = 3;

const DB_TIMEOUT_MS = 3_000;

/** «Твой стиль»; `null` во всех полях, кроме `runs` и `missing`, — забегов пока мало. */
export interface StyleSummary {
  style: AxisId | null;
  strong: AxisId | null;
  weak: AxisId | null;
  /** средние индексы осей с тремя знаками */
  axes: AxisValues | null;
  /** сколько забегов вошло в среднее */
  runs: number;
  /** сколько забегов не хватает до стиля; 0 — стиль есть */
  missing: number;
}

/**
 * Чистое правило «Твоего стиля». `runs` — оси забегов от новых к старым; в
 * среднее идут первые `STYLE_RUNS`. Оси сравниваются по округлённым средним —
 * тем, что видит игрок. При равенстве сильной берётся первая ось по порядку
 * `t, k, h, c, b`, слабой — последняя: у ровного игрока оси различаются.
 */
export function summarizeStyle(runs: readonly AxisValues[], cap: number): StyleSummary {
  const used = runs.slice(0, STYLE_RUNS);
  if (used.length < MIN_STYLE_RUNS) return { style: null, strong: null, weak: null, axes: null, runs: used.length, missing: MIN_STYLE_RUNS - used.length };
  const axes = { t: 0, k: 0, h: 0, c: 0, b: 0 };
  for (const run of used) {
    for (const axis of AXIS_IDS) axes[axis] += Math.min(run[axis], cap);
  }
  for (const axis of AXIS_IDS) axes[axis] = roundIndex(axes[axis] / used.length);
  let strong: AxisId = "t";
  let weak: AxisId = "t";
  for (const axis of AXIS_IDS) {
    if (axes[axis] > axes[strong]) strong = axis;
    if (axes[axis] <= axes[weak]) weak = axis;
  }
  return { style: strong, strong, weak, axes, runs: used.length, missing: 0 };
}

/** Окно сезона для выбора лучшего забега: конец исключительно. */
export interface StyleWindow {
  from: Date;
  to: Date;
}

export const PLAYER_STYLE_REPOSITORY = Symbol("PLAYER_STYLE_REPOSITORY");

export interface PlayerStyleRepository {
  /** Оси последних рейтинговых забегов аккаунта, новые первыми. */
  recentAxes(accountId: string, since: Date | null, limit: number): Promise<AxisValues[]>;
  /** Стиль лучшего по очкам рейтингового забега каждого аккаунта в окне (`null` — за всё время); у кого забегов нет — не попадает в ответ. */
  bestStyles(accountIds: readonly string[], window: StyleWindow | null, since: Date | null): Promise<Map<string, AxisId>>;
}

@Injectable()
export class PrismaPlayerStyleRepository implements PlayerStyleRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async recentAxes(accountId: string, since: Date | null, limit: number): Promise<AxisValues[]> {
    const rows = await this.prisma.run.findMany({
      // Игрок под молчаливым ограничением рейтинга видит свой стиль: его забеги не рейтинговые лишь для других.
      where: { accountId, status: "finished", points: { not: null }, OR: [{ ranked: true }, { ratingRestricted: "silent" }], ...ratedWhere(since) },
      orderBy: { finishedAt: "desc" },
      take: limit,
      select: { axes: true },
    });
    // Колонка — JSON из базы: строка, правленная руками, пропускается, а не роняет ответ.
    return rows.flatMap((row) => {
      const axes = storedAxesSchema.safeParse(row.axes);
      return axes.success ? [axes.data] : [];
    });
  }

  async bestStyles(accountIds: readonly string[], window: StyleWindow | null, since: Date | null): Promise<Map<string, AxisId>> {
    const found = new Map<string, AxisId>();
    if (accountIds.length === 0) return found;
    // Нижняя граница — позже из двух: начала окна и отсечки рейтинга.
    const from = since !== null && (window === null || since.getTime() > window.from.getTime()) ? since : (window?.from ?? null);
    const finishedAt = { ...(from === null ? {} : { gte: from }), ...(window === null ? {} : { lt: window.to }) };
    // `distinct` с сортировкой по очкам берёт лучший забег каждого аккаунта; при равных очках побеждает ранний.
    const rows = await this.prisma.run.findMany({
      where: { ...ratedWhere(null), finishedAt, accountId: { in: [...accountIds] }, status: "finished", ranked: true, points: { not: null } },
      orderBy: [{ accountId: "asc" }, { points: "desc" }, { finishedAt: "asc" }],
      distinct: ["accountId"],
      select: { accountId: true, style: true },
    });
    for (const row of rows) {
      const style = AXIS_IDS.find((axis) => axis === row.style);
      if (style !== undefined) found.set(row.accountId, style);
    }
    return found;
  }
}

@Injectable()
export class PlayerStyleService {
  constructor(
    @Inject(PLAYER_STYLE_REPOSITORY) private readonly repository: PlayerStyleRepository,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  /**
   * Стиль у имени для пачки аккаунтов: лучший по очкам забег `window` (текущего
   * сезона), а у кого его нет, — лучший за всё время. Без стиля аккаунта в
   * ответе нет.
   */
  async styleOfMany(accountIds: readonly string[], window: StyleWindow | null): Promise<Map<string, AxisId>> {
    const unique = [...new Set(accountIds)];
    const since = ratingSinceOf(this.settings.get(SETTINGS.ratingSinceDate));
    const found = window === null ? new Map<string, AxisId>() : await withTimeout(this.repository.bestStyles(unique, window, since), DB_TIMEOUT_MS, "rating: стиль сезона");
    const rest = unique.filter((id) => !found.has(id));
    if (rest.length === 0) return found;
    for (const [id, style] of await withTimeout(this.repository.bestStyles(rest, null, since), DB_TIMEOUT_MS, "rating: стиль за всё время")) found.set(id, style);
    return found;
  }

  /** «Твой стиль» аккаунта по последним рейтинговым забегам. */
  async myStyle(accountId: string): Promise<StyleSummary> {
    const since = ratingSinceOf(this.settings.get(SETTINGS.ratingSinceDate));
    const runs = await withTimeout(this.repository.recentAxes(accountId, since, STYLE_RUNS), DB_TIMEOUT_MS, "rating: последние забеги");
    return summarizeStyle(runs, this.settings.get(SETTINGS.ratingIndexCap));
  }
}
