import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import { isRatedRun, ratingSinceOf } from "../runs/rated-runs.js";
import { storedDetailsSchema, storedWeaponsSchema } from "../runs/run-details.js";
import { isRatedDifficulty, type Difficulty } from "../runs/run-rules.js";
import { EXPECTED_TABLE_SOURCE, expectedRowOf, type ExpectedTableSource } from "./expected-table.js";
import { RunScorer } from "./run-scorer.service.js";
import { storedScoreInputSchema, storedScoreOf, type StoredScore } from "./score-types.js";
import { AXIS_IDS, minuteOf, type AxisId } from "./score-rules.js";

/**
 * Карточка забега (tasks/T-0297, Р66, Р152, docs/35-stage4-plan.md WP35):
 * пять осей очков против ожидаемого, разбор очков и сборка. Открывается из
 * рейтинга, с экрана итогов и из истории.
 *
 * **Что видит чужой.** Только рейтинговый забег (`ranked`), на рейтинговой
 * сложности и не раньше отсечки, и только если рейтинг его хозяину не закрыт:
 * ограниченного игрока нет в досках, нет и его карточки. Свой забег хозяин
 * видит всегда, если у него есть очки. Всё остальное — тот же 404, что у
 * незнакомого ключа: по ответу не угадать, что забег существует.
 *
 * **Чего в ответе нет.** Идентификатора аккаунта, имени на площадке, устройства
 * и времени записи: имя и фото — те же, что в строке рейтинга.
 */

const DB_TIMEOUT_MS = 3_000;
/** Очков за идеальную по всем осям ось: тот же масштаб, что у `pointsOf` (score-rules.ts). */
const POINTS_SCALE = 1_000;
/** Меньше полуминуты для темпа не берётся — так же считает подсчёт очков. */
const MIN_MINUTES = 0.5;

export class RunCardNotFoundError extends DomainError {
  constructor() {
    super("run_not_found", "Забег не найден", 404);
  }
}

/** Строка забега с игроком — всё, что нужно карточке; сырые колонки читает сервис схемами. */
export interface RunCardRow {
  runId: string;
  accountId: string;
  difficulty: Difficulty;
  finishedAt: Date;
  ranked: boolean;
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  startingWeaponId: string;
  weapons: unknown;
  details: unknown;
  points: number | null;
  axes: unknown;
  style: string | null;
  band: string | null;
  scoreInput: unknown;
  displayName: string;
  photoUrl: string | null;
  tester: boolean;
}

export interface RunCardRepository {
  /** законченный забег с игроком; незнакомый и незаконченный — `null` */
  find(runId: string): Promise<RunCardRow | null>;
  /** бусты, купленные на забег и не возвращённые */
  boostsOf(runId: string): Promise<string[]>;
}

export const RUN_CARD_REPOSITORY = Symbol("RUN_CARD_REPOSITORY");

@Injectable()
export class PrismaRunCardRepository implements RunCardRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async find(runId: string): Promise<RunCardRow | null> {
    const row = await this.prisma.run.findFirst({
      where: { runId, status: "finished", finishedAt: { not: null }, survivalSec: { not: null } },
      select: {
        runId: true,
        accountId: true,
        difficulty: true,
        finishedAt: true,
        ranked: true,
        survivalSec: true,
        level: true,
        enemiesKilled: true,
        startingWeaponId: true,
        weapons: true,
        details: true,
        points: true,
        axes: true,
        style: true,
        band: true,
        scoreInput: true,
        account: { select: { displayName: true, photoUrl: true, testerAt: true } },
      },
    });
    if (row === null || row.finishedAt === null || row.survivalSec === null) return null;
    return {
      runId: row.runId,
      accountId: row.accountId,
      difficulty: row.difficulty,
      finishedAt: row.finishedAt,
      ranked: row.ranked,
      survivalSec: row.survivalSec,
      level: row.level ?? 1,
      enemiesKilled: row.enemiesKilled ?? 0,
      startingWeaponId: row.startingWeaponId,
      weapons: row.weapons,
      details: row.details,
      points: row.points,
      axes: row.axes,
      style: row.style,
      band: row.band,
      scoreInput: row.scoreInput,
      displayName: row.account.displayName,
      photoUrl: row.account.photoUrl,
      tester: row.account.testerAt !== null,
    };
  }

  async boostsOf(runId: string): Promise<string[]> {
    const row = await this.prisma.runBoost.findUnique({ where: { runId }, select: { boosts: true, refundedAt: true } });
    return row === null || row.refundedAt !== null ? [] : row.boosts;
  }
}

/** Ось в разборе: индекс забега и слагаемое очков против слагаемого ожидаемого (индекс 1). */
export interface CardAxisView {
  axis: AxisId;
  /** сырой индекс оси, три знака; 1 — ровно ожидаемое */
  index: number;
  /** слагаемое очков: `1000 × вес × min(индекс, потолок)` */
  points: number;
  /** слагаемое ожидаемого забега: `1000 × вес × 1` */
  expectedPoints: number;
}

export interface RunCardView {
  runId: string;
  /** забег — того, кто смотрит */
  mine: boolean;
  player: { name: string; photoUrl: string | null; tester?: true };
  survivalSec: number;
  level: number;
  /** сила на старте (`pressure.power`); `null` — забег прислан сборкой без неё */
  power: number | null;
  startingWeaponId: string;
  points: number;
  /** очки забега той же длины, сыгранного ровно по ожидаемому */
  expectedPoints: number;
  style: AxisId;
  band: string;
  /** потолок индекса в очках: шкала «паутины» от нуля до него */
  cap: number;
  axes: CardAxisView[];
  /** числа для подписей осей; клиент составляет слова сам */
  facts: {
    killsPerMin: number;
    bossKills: number | null;
    eliteKills: number | null;
    /** полученный урон в минуту против ожидаемого, %; `null` — счётчика или таблицы нет */
    damageDeltaPct: number | null;
  };
  build: {
    weapons: { id: string; level: number }[];
    passives: { id: string; level: number }[];
    boosts: string[];
  };
}

@Injectable()
export class RunCardService {
  constructor(
    @Inject(RUN_CARD_REPOSITORY) private readonly repository: RunCardRepository,
    @Inject(EXPECTED_TABLE_SOURCE) private readonly table: ExpectedTableSource,
    private readonly scorer: RunScorer,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(AccountRestrictions) private readonly restrictions: Pick<AccountRestrictions, "status">,
  ) {}

  async card(viewerId: string, runId: string): Promise<RunCardView> {
    const row = await withTimeout(this.repository.find(runId), DB_TIMEOUT_MS, "карточка забега: строка");
    if (row === null) throw new RunCardNotFoundError();
    const mine = row.accountId === viewerId;
    if (!mine && !(await this.openToOthers(row))) throw new RunCardNotFoundError();

    // Очков нет — показывать нечего даже хозяину: пролог, сбой подсчёта, забег до очков.
    const score = storedScoreOf({ points: row.points, axes: row.axes, style: row.style, band: row.band });
    if (score === null) throw new RunCardNotFoundError();

    const boosts = await withTimeout(this.repository.boostsOf(runId), DB_TIMEOUT_MS, "карточка забега: бусты");
    return this.view(row, score, mine, boosts);
  }

  /** Чужой видит рейтинговый забег рейтингового игрока: тот же отбор, что у досок. */
  private async openToOthers(row: RunCardRow): Promise<boolean> {
    if (!row.ranked || !isRatedDifficulty(row.difficulty)) return false;
    if (!isRatedRun(row.difficulty, row.finishedAt, ratingSinceOf(this.settings.get(SETTINGS.ratingSinceDate)))) return false;
    return (await withTimeout(this.restrictions.status(row.accountId, "leaderboard"), DB_TIMEOUT_MS, "карточка забега: ограничение")) === null;
  }

  private view(row: RunCardRow, score: StoredScore, mine: boolean, boosts: string[]): RunCardView {
    const params = this.scorer.scoreParams();
    const axes = AXIS_IDS.map((axis): CardAxisView => {
      const weight = params.weights[axis];
      return {
        axis,
        index: score.axes[axis],
        points: Math.round(POINTS_SCALE * weight * Math.min(score.axes[axis], params.cap)),
        expectedPoints: Math.round(POINTS_SCALE * weight),
      };
    });
    const details = storedDetailsSchema.safeParse(row.details);
    const weapons = storedWeaponsSchema.safeParse(row.weapons);
    const input = storedScoreInputSchema.safeParse(row.scoreInput);
    return {
      runId: row.runId,
      mine,
      player: { name: row.displayName, photoUrl: row.photoUrl, ...(row.tester ? { tester: true as const } : {}) },
      survivalSec: row.survivalSec,
      level: row.level,
      power: input.success ? input.data.power : null,
      startingWeaponId: row.startingWeaponId,
      points: score.points,
      expectedPoints: this.scorer.expectedPointsFor(score.axes.t),
      style: score.style,
      band: score.band,
      cap: params.cap,
      axes,
      facts: {
        killsPerMin: Math.round(row.enemiesKilled / minutesOf(row.survivalSec)),
        bossKills: details.success ? details.data.bossKills : null,
        eliteKills: details.success ? details.data.eliteKills : null,
        damageDeltaPct: details.success ? this.damageDelta(row, score.band, details.data.damageTaken) : null,
      },
      build: {
        weapons: weapons.success ? weapons.data.map(({ id, level }) => ({ id, level })) : [],
        passives: details.success ? details.data.passives : [],
        boosts,
      },
    };
  }

  /** Урон в минуту против ожидаемого для полосы и минуты забега; без таблицы или счётчика — `null`. */
  private damageDelta(row: RunCardRow, band: string, damageTaken: number | null): number | null {
    const table = this.table.get();
    if (table === null || damageTaken === null) return null;
    try {
      const expected = expectedRowOf(table, band, minuteOf(row.survivalSec)).damageTakenPerMin;
      if (!(expected > 0)) return null;
      return Math.round((damageTaken / minutesOf(row.survivalSec) / expected - 1) * 100);
    } catch {
      // Полосы нет в таблице (таблицу пересобрали) — подпись просто не рисуется.
      return null;
    }
  }
}

function minutesOf(survivalSec: number): number {
  return Math.max(survivalSec / 60, MIN_MINUTES);
}
