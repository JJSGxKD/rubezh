import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { ratedWhere } from "./rated-runs.js";
import { storedScoreOf, type StoredScore, type StoredScoreInput } from "../rating/score-types.js";
import { storedDetailsSchema, storedWeaponsSchema, type StoredDetails } from "./run-details.js";
import { isRatedDifficulty, type Difficulty, type RunMode } from "./run-rules.js";
import type { RunVerdict, VerdictReason } from "./run-verdict.js";

/**
 * Забеги в Postgres (docs/34-stage3-plan.md, WP4). Запрос к базе живёт здесь,
 * а не в сервисе (docs/15-engineering-standards.md §2.3).
 *
 * Идемпотентность — первичным ключом `run_id`, а не проверкой в коде: два
 * одновременных итога одного забега упираются в базу, и прошедшим считается
 * ровно один (docs/15-engineering-standards.md §4.1).
 *
 * Рейтинговые запросы (лучшее, доска, список модератора, снятие с рейтинга)
 * берут `since` последним параметром — отсечку рейтинга (Р126, `rated-runs.ts`):
 * забеги нерейтинговой сложности и законченные раньше неё не видны. Для
 * нерейтинговой сложности запрос в базу не уходит вовсе. История (`recent`,
 * `stats`, `detail`, `review`) остаётся полной.
 *
 * **Доска всех времён ранжирует по очкам** (tasks/T-0294): лучший забег — с
 * наибольшим `points`, при равных раньше законченный; забег без очков (пролог,
 * сбой подсчёта, забег до очков и не пересчитанный) в выборку не входит, а
 * время лучшего забега идёт подписью.
 */

/**
 * Забег сдан под ограничением рейтинга (docs/35-stage4-plan.md WP44): в
 * рейтинг не идёт ни сейчас, ни после снятия. `notified` — игроку сообщили,
 * `silent` — молча: игрок видит себя в досках, другие его нет.
 */
export type RatingRestricted = "notified" | "silent";

export interface RunStartRecord {
  runId: string;
  accountId: string;
  difficulty: Difficulty;
  /** режим; не задан — бесконечный (колонка по умолчанию `endless`) */
  mode?: RunMode;
  startingWeaponId: string;
  contentHash: string;
  startedAt: Date | null;
}

export interface RunFinishRecord {
  runId: string;
  accountId: string;
  difficulty: Difficulty;
  /** режим, которым забег записан: старт мог назвать пролог, а признак к итогу уже встал; не задан — как при старте */
  mode?: RunMode;
  startingWeaponId: string;
  contentHash: string;
  finishedAt: Date;
  outcome: "died" | "abandoned";
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  weapons: { id: string; level: number; damage?: number | undefined }[];
  /** подробности для листа забега; `null` — сборка их не прислала */
  details: StoredDetails | null;
  deathCause: string | null;
  cheats: boolean;
  /** секунда каждого второго шанса */
  continues: number[];
  ranked: boolean;
  ratingRestricted: RatingRestricted | null;
  verdict: RunVerdict;
  verdictReasons: VerdictReason[];
  /** страж рубежа пришёл — со слов итога (T-0121); победой её делает вердикт `ok` */
  rubezhReached: boolean;
  /** секунда победы со слов итога; `null` — страж не пал */
  rubezhClearedSec: number | null;
  /** очки эффективности (T-0293); `null` — пролог, обучение или сбой подсчёта */
  score?: StoredScore | null | undefined;
  /** исходные числа для пересчёта очков; `null` — нерейтинговая сложность */
  scoreInput?: StoredScoreInput | null | undefined;
}

export interface StoredRun {
  runId: string;
  accountId: string;
  status: "started" | "finished";
  difficulty: Difficulty;
  startedAt: Date | null;
  /** когда закончен; `null` — забег ещё не закончен */
  finishedAt: Date | null;
  /** записанное время выживания; `null` — забег ещё не закончен */
  survivalSec: number | null;
  verdict: RunVerdict | null;
  ranked: boolean;
  ratingRestricted: RatingRestricted | null;
  cheats: boolean;
  rubezhReached: boolean;
  rubezhClearedSec: number | null;
  /** записанные очки; `null` — очков нет */
  score: StoredScore | null;
}

/** `foreign` — забег с таким ключом уже принадлежит другому аккаунту. */
export type StartOutcome = "created" | "exists" | "foreign";
export type FinishOutcome = "finished" | "duplicate" | "foreign";

export interface RecentRun {
  runId: string;
  difficulty: Difficulty;
  survivalSec: number;
  level: number;
  startingWeaponId: string;
  finishedAt: Date;
}

export interface BestRunRow {
  /** ключ забега: по нему строка рейтинга открывает карточку забега (T-0297) */
  runId?: string;
  accountId: string;
  displayName: string;
  photoUrl: string | null;
  /** знак «Тестер» (Р87); поля нет — не тестер, а дата знака наружу не отдаётся */
  tester?: true;
  survivalSec: number;
  /** очки эффективности забега; `null` — очков нет */
  points: number | null;
  /** стиль забега (T-0293); `null` — очков нет */
  style: string | null;
  level: number;
  startingWeaponId: string;
  enemiesKilled: number;
}

/** Забег, который модератор может снять с рейтинга или вернуть (docs/35-stage4-plan.md WP44, часть 3б). */
export interface ModerationRunRow {
  runId: string;
  difficulty: Difficulty;
  survivalSec: number;
  /** очки эффективности; `null` — очков нет */
  points: number | null;
  level: number;
  enemiesKilled: number;
  startingWeaponId: string;
  finishedAt: Date;
  /** `false` — снят с рейтинга модератором: вердикт честный, читов нет, ограничения не было */
  ranked: boolean;
}

export interface ReviewRow {
  runId: string;
  accountId: string;
  verdict: RunVerdict;
  verdictReasons: string[];
  difficulty: Difficulty;
  survivalSec: number | null;
  level: number | null;
  enemiesKilled: number | null;
  finishedAt: Date | null;
}

/** Свой законченный забег целиком — для листа в профиле. */
export interface RunDetailRow {
  runId: string;
  difficulty: Difficulty;
  startingWeaponId: string;
  finishedAt: Date;
  outcome: "died" | "abandoned";
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  weapons: { id: string; level: number; damage: number | null }[];
  details: StoredDetails | null;
  deathCause: string | null;
  cheats: boolean;
  continues: number;
  ranked: boolean;
  ratingRestricted: RatingRestricted | null;
  verdict: RunVerdict | null;
  /** очки эффективности (T-0293): по ним лист решает, есть ли у забега карточка (T-0297); поля нет — не прислано */
  points?: number | null;
}

export const RUNS_REPOSITORY = Symbol("RUNS_REPOSITORY");

export interface RunsRepository {
  find(runId: string): Promise<StoredRun | null>;
  start(record: RunStartRecord): Promise<StartOutcome>;
  finish(record: RunFinishRecord): Promise<FinishOutcome>;
  stats(accountId: string): Promise<{ runs: number; totalKills: number; totalSurvivalSec: number }>;
  recent(accountId: string, limit: number): Promise<RecentRun[]>;
  /** свой законченный забег; чужой, незаконченный и незнакомый — `null` */
  detail(accountId: string, runId: string): Promise<RunDetailRow | null>;
  /** Лучший по очкам рейтинговый забег каждого из аккаунтов — для строк лидерборда */
  bestRuns(accountIds: readonly string[], difficulty: Difficulty, since: Date | null): Promise<BestRunRow[]>;
  /** Лучшие рейтинговые очки каждого аккаунта — источник пересборки проекции */
  bestScores(difficulty: Difficulty, since: Date | null): Promise<{ accountId: string; score: number }[]>;
  /**
   * Лучший по очкам рейтинговый забег игрока — вернуть его в доску, когда ограничение
   * рейтинга снято. `shadow` — вместе со сданными под молчаливым
   * ограничением: так игрок видит себя сам.
   */
  bestRunOf(accountId: string, difficulty: Difficulty, shadow: boolean, since: Date | null): Promise<BestRunRow | null>;
  /**
   * Забеги игрока, которые модератор может снять с рейтинга или вернуть:
   * рейтинговые и снятые модератором, лучшие по очкам первыми.
   */
  moderationRuns(accountId: string, difficulty: Difficulty, limit: number, since: Date | null): Promise<ModerationRunRow[]>;
  /**
   * Снять с рейтинга или вернуть — условно: снять можно только рейтинговый,
   * вернуть — только снятый модератором. Забег нерейтинговой сложности или
   * законченный раньше отсечки не меняется ни в ту, ни в другую сторону:
   * иначе он, с честным вердиктом и `ranked = false`, выглядел бы как «снятый
   * модератором», и его можно было бы «вернуть» в рейтинг. `null` — менять нечего.
   */
  setRanked(runId: string, ranked: boolean, since: Date | null): Promise<{ accountId: string; difficulty: Difficulty; survivalSec: number } | null>;
  review(limit: number): Promise<ReviewRow[]>;
  /**
   * Аккаунты с засчитанной победой над стражем на этой сложности: рейтинговый
   * забег, вердикт `ok`, победа заявлена (T-0121). Источник пересборки набора
   * `lb:rubezh:*`; `only` сужает выборку одним-двумя аккаунтами (снятие забега
   * модератором). Нерейтинговая сложность — пусто, без запроса.
   */
  rubezhWinners(difficulty: Difficulty, since: Date | null, only?: readonly string[]): Promise<string[]>;
}

@Injectable()
export class PrismaRunsRepository implements RunsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async find(runId: string): Promise<StoredRun | null> {
    const row = await this.prisma.run.findUnique({
      where: { runId },
      select: {
        runId: true,
        accountId: true,
        status: true,
        difficulty: true,
        startedAt: true,
        finishedAt: true,
        survivalSec: true,
        verdict: true,
        ranked: true,
        ratingRestricted: true,
        cheats: true,
        rubezhReached: true,
        rubezhClearedSec: true,
        points: true,
        axes: true,
        style: true,
        band: true,
      },
    });
    if (row === null) return null;
    const { points, axes, style, band, ...rest } = row;
    return { ...rest, ratingRestricted: ratingRestrictedOf(row.ratingRestricted), score: storedScoreOf({ points, axes, style, band }) };
  }

  async start(record: RunStartRecord): Promise<StartOutcome> {
    try {
      await this.prisma.run.create({ data: { ...record, status: "started", verdictReasons: [] } });
      return "created";
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      // Повтор старта из очереди — не ошибка. Чужой ключ — ошибка.
      const existing = await this.find(record.runId);
      return existing?.accountId === record.accountId ? "exists" : "foreign";
    }
  }

  async finish(record: RunFinishRecord): Promise<FinishOutcome> {
    const existing = await this.find(record.runId);
    if (existing !== null && existing.accountId !== record.accountId) return "foreign";
    if (existing?.status === "finished") return "duplicate";

    const finished = {
      status: "finished" as const,
      ...(record.mode === undefined ? {} : { mode: record.mode }),
      finishedAt: record.finishedAt,
      outcome: record.outcome,
      survivalSec: record.survivalSec,
      level: record.level,
      enemiesKilled: record.enemiesKilled,
      weapons: record.weapons,
      details: record.details ?? Prisma.DbNull,
      deathCause: record.deathCause,
      cheats: record.cheats,
      continues: record.continues,
      ranked: record.ranked,
      ratingRestricted: record.ratingRestricted,
      verdict: record.verdict,
      verdictReasons: record.verdictReasons,
      rubezhReached: record.rubezhReached,
      rubezhClearedSec: record.rubezhClearedSec,
      points: record.score?.points ?? null,
      axes: record.score?.axes ?? Prisma.DbNull,
      style: record.score?.style ?? null,
      band: record.score?.band ?? null,
      scoreInput: record.scoreInput ?? Prisma.DbNull,
    };

    if (existing !== null) {
      // Условие на статус — защита от гонки: из двух одновременных итогов
      // обновит строку ровно один, второй увидит ноль и станет повтором.
      const updated = await this.prisma.run.updateMany({
        where: { runId: record.runId, accountId: record.accountId, status: "started" },
        data: finished,
      });
      return updated.count === 1 ? "finished" : "duplicate";
    }

    try {
      await this.prisma.run.create({
        data: {
          runId: record.runId,
          accountId: record.accountId,
          difficulty: record.difficulty,
          startingWeaponId: record.startingWeaponId,
          contentHash: record.contentHash,
          startedAt: null,
          ...finished,
        },
      });
      return "finished";
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.find(record.runId);
      return raced?.accountId === record.accountId ? "duplicate" : "foreign";
    }
  }

  async stats(accountId: string): Promise<{ runs: number; totalKills: number; totalSurvivalSec: number }> {
    // Считает база, а не выгрузка строк в память (docs/13-reuse-from-vpnsibcom.md §7).
    const aggregate = await this.prisma.run.aggregate({
      where: { accountId, status: "finished" },
      _count: { _all: true },
      _sum: { enemiesKilled: true, survivalSec: true },
    });
    return {
      runs: aggregate._count._all,
      totalKills: aggregate._sum.enemiesKilled ?? 0,
      totalSurvivalSec: aggregate._sum.survivalSec ?? 0,
    };
  }

  async recent(accountId: string, limit: number): Promise<RecentRun[]> {
    const rows = await this.prisma.run.findMany({
      where: { accountId, status: "finished" },
      orderBy: { finishedAt: "desc" },
      take: limit,
      select: { runId: true, difficulty: true, survivalSec: true, level: true, startingWeaponId: true, finishedAt: true },
    });
    return rows.map((row) => ({
      runId: row.runId,
      difficulty: row.difficulty,
      survivalSec: row.survivalSec ?? 0,
      level: row.level ?? 1,
      startingWeaponId: row.startingWeaponId,
      finishedAt: row.finishedAt ?? new Date(0),
    }));
  }

  async detail(accountId: string, runId: string): Promise<RunDetailRow | null> {
    // Чужой забег не отдаём: идентификатор забега — не пропуск к чужим числам.
    const row = await this.prisma.run.findFirst({
      where: { runId, accountId, status: "finished" },
      select: {
        runId: true,
        difficulty: true,
        startingWeaponId: true,
        finishedAt: true,
        outcome: true,
        survivalSec: true,
        level: true,
        enemiesKilled: true,
        weapons: true,
        details: true,
        deathCause: true,
        cheats: true,
        continues: true,
        ranked: true,
        ratingRestricted: true,
        verdict: true,
        points: true,
      },
    });
    if (row === null) return null;
    const weapons = storedWeaponsSchema.safeParse(row.weapons);
    const details = storedDetailsSchema.safeParse(row.details);
    return {
      runId: row.runId,
      difficulty: row.difficulty,
      startingWeaponId: row.startingWeaponId,
      finishedAt: row.finishedAt ?? new Date(0),
      outcome: row.outcome ?? "died",
      survivalSec: row.survivalSec ?? 0,
      level: row.level ?? 1,
      enemiesKilled: row.enemiesKilled ?? 0,
      // Битый JSON — без этой части, а не без листа целиком.
      weapons: weapons.success ? weapons.data.map((weapon) => ({ id: weapon.id, level: weapon.level, damage: weapon.damage ?? null })) : [],
      details: details.success ? details.data : null,
      deathCause: row.deathCause,
      cheats: row.cheats,
      continues: row.continues.length,
      ranked: row.ranked,
      ratingRestricted: ratingRestrictedOf(row.ratingRestricted),
      verdict: row.verdict,
      points: row.points,
    };
  }

  async bestRuns(accountIds: readonly string[], difficulty: Difficulty, since: Date | null): Promise<BestRunRow[]> {
    if (accountIds.length === 0 || !isRatedDifficulty(difficulty)) return [];
    // Один запрос на всю страницу, а не по запросу на строку: `distinct` с
    // сортировкой по очкам берёт лучший забег каждого аккаунта.
    const rows = await this.prisma.run.findMany({
      where: { ...ratedWhere(since), accountId: { in: [...accountIds] }, difficulty, ranked: true, points: { not: null } },
      orderBy: [{ accountId: "asc" }, { points: "desc" }, { finishedAt: "asc" }],
      distinct: ["accountId"],
      select: {
        runId: true,
        accountId: true,
        survivalSec: true,
        points: true,
        style: true,
        level: true,
        startingWeaponId: true,
        enemiesKilled: true,
        account: { select: { displayName: true, photoUrl: true, testerAt: true } },
      },
    });
    return rows.map((row) => ({
      runId: row.runId,
      accountId: row.accountId,
      displayName: row.account.displayName,
      photoUrl: row.account.photoUrl,
      ...(row.account.testerAt === null ? {} : { tester: true as const }),
      survivalSec: row.survivalSec ?? 0,
      points: row.points,
      style: row.style,
      level: row.level ?? 1,
      startingWeaponId: row.startingWeaponId,
      enemiesKilled: row.enemiesKilled ?? 0,
    }));
  }

  async bestScores(difficulty: Difficulty, since: Date | null): Promise<{ accountId: string; score: number }[]> {
    if (!isRatedDifficulty(difficulty)) return [];
    const rows = await this.prisma.run.groupBy({
      by: ["accountId"],
      where: { ...ratedWhere(since), difficulty, ranked: true, points: { not: null } },
      _max: { points: true },
    });
    return rows.map((row) => ({ accountId: row.accountId, score: row._max.points ?? 0 }));
  }

  async bestRunOf(accountId: string, difficulty: Difficulty, shadow: boolean, since: Date | null): Promise<BestRunRow | null> {
    if (!isRatedDifficulty(difficulty)) return null;
    const row = await this.prisma.run.findFirst({
      where: { ...ratedWhere(since), accountId, difficulty, status: "finished", OR: shadow ? [{ ranked: true }, { ratingRestricted: "silent" }] : [{ ranked: true }], points: { not: null } },
      orderBy: [{ points: "desc" }, { finishedAt: "asc" }],
      select: {
        runId: true,
        accountId: true,
        survivalSec: true,
        points: true,
        style: true,
        level: true,
        startingWeaponId: true,
        enemiesKilled: true,
        account: { select: { displayName: true, photoUrl: true, testerAt: true } },
      },
    });
    if (row === null) return null;
    return {
      runId: row.runId,
      accountId: row.accountId,
      displayName: row.account.displayName,
      photoUrl: row.account.photoUrl,
      ...(row.account.testerAt === null ? {} : { tester: true as const }),
      survivalSec: row.survivalSec ?? 0,
      points: row.points,
      style: row.style,
      level: row.level ?? 1,
      startingWeaponId: row.startingWeaponId,
      enemiesKilled: row.enemiesKilled ?? 0,
    };
  }

  async moderationRuns(accountId: string, difficulty: Difficulty, limit: number, since: Date | null): Promise<ModerationRunRow[]> {
    if (!isRatedDifficulty(difficulty)) return [];
    const rows = await this.prisma.run.findMany({
      where: { ...ratedWhere(since), accountId, difficulty, status: "finished", OR: [{ ranked: true }, UNRANKED_BY_MODERATOR] },
      orderBy: [{ points: { sort: "desc", nulls: "last" } }, { survivalSec: "desc" }, { finishedAt: "desc" }],
      take: limit,
      select: { runId: true, difficulty: true, survivalSec: true, points: true, level: true, enemiesKilled: true, startingWeaponId: true, finishedAt: true, ranked: true },
    });
    return rows.map((row) => ({
      runId: row.runId,
      difficulty: row.difficulty,
      survivalSec: row.survivalSec ?? 0,
      points: row.points,
      level: row.level ?? 1,
      enemiesKilled: row.enemiesKilled ?? 0,
      startingWeaponId: row.startingWeaponId,
      finishedAt: row.finishedAt ?? new Date(0),
      ranked: row.ranked,
    }));
  }

  async setRanked(runId: string, ranked: boolean, since: Date | null): Promise<{ accountId: string; difficulty: Difficulty; survivalSec: number } | null> {
    // Условие — в самом обновлении: два нажатия разом меняют забег однажды;
    // рейтинговость забега (сложность и отсечка) проверяется там же, а не до него.
    const counted = { ...ratedWhere(since), runId, status: "finished" as const };
    const where = ranked ? { ...counted, ...UNRANKED_BY_MODERATOR } : { ...counted, ranked: true };
    const { count } = await this.prisma.run.updateMany({ where, data: { ranked } });
    if (count === 0) return null;
    const row = await this.prisma.run.findUnique({ where: { runId }, select: { accountId: true, difficulty: true, survivalSec: true } });
    return row === null ? null : { accountId: row.accountId, difficulty: row.difficulty, survivalSec: row.survivalSec ?? 0 };
  }

  async review(limit: number): Promise<ReviewRow[]> {
    const rows = await this.prisma.run.findMany({
      where: { verdict: { in: ["suspicious", "rejected"] } },
      orderBy: { finishedAt: "desc" },
      take: limit,
      select: {
        runId: true,
        accountId: true,
        verdict: true,
        verdictReasons: true,
        difficulty: true,
        survivalSec: true,
        level: true,
        enemiesKilled: true,
        finishedAt: true,
      },
    });
    return rows.map((row) => ({ ...row, verdict: row.verdict ?? "suspicious" }));
  }

  async rubezhWinners(difficulty: Difficulty, since: Date | null, only?: readonly string[]): Promise<string[]> {
    if (!isRatedDifficulty(difficulty) || only?.length === 0) return [];
    const rows = await this.prisma.run.groupBy({
      by: ["accountId"],
      where: {
        ...ratedWhere(since),
        difficulty,
        ranked: true,
        verdict: "ok",
        // Забег с читами в рейтинг может попасть (владелец, админ), победой он не считается: так же в finish и в повторе.
        cheats: false,
        rubezhReached: true,
        rubezhClearedSec: { not: null },
        ...(only === undefined ? {} : { accountId: { in: [...only] } }),
      },
    });
    return rows.map((row) => row.accountId);
  }
}

/**
 * Снят с рейтинга модератором: вердикт честный, читов нет и сдан не под
 * ограничением — иначе забег и не был бы рейтинговым. Другого пути к такому
 * сочетанию нет, поэтому отдельная пометка не нужна.
 */
const UNRANKED_BY_MODERATOR = { ranked: false, verdict: "ok" as const, cheats: false, ratingRestricted: null };

/** Колонка — строкой: незнакомое значение читается как «без ограничения», а не роняет чтение. */
function ratingRestrictedOf(value: string | null): RatingRestricted | null {
  return value === "notified" || value === "silent" ? value : null;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
