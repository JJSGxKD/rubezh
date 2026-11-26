import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminRunReviewController } from "../src/modules/admin/admin-run-review.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import type { RunScorer } from "../src/modules/rating/run-scorer.service.js";
import { RatingRestrictions } from "../src/modules/runs/rating-restrictions.js";
import { availableActions, decide, inQueue, returnableToRating, reviewOutcomeOf, TRANSITIONS, type ReviewAction, type ReviewOutcome } from "../src/modules/runs/run-review-rules.js";
import { RUN_REVIEW_REPOSITORY, type RunReportRow, type RunReviewRepository } from "../src/modules/runs/run-review.repository.js";
import { RunReviewService } from "../src/modules/runs/run-review.service.js";
import { RunNotFoundError } from "../src/modules/runs/runs-view.service.js";
import { RunRankingConflictError, RunsService } from "../src/modules/runs/runs.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";

/**
 * Отчёт забега и решения разбора (Р203, tasks/T-0419): правила переходов,
 * сервис на подставных репозиториях и ручки по HTTP. Живые Postgres и Redis —
 * `run-review.integration.test.ts`.
 */

const SINCE = new Date("2026-10-26T00:00:00.000Z");
const FINISHED = new Date("2026-11-05T12:00:00.000Z");
const DEFAULT_COMMENT = "Разбор: честный забег";
const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

describe("правила разбора: переходы", () => {
  const states: (ReviewOutcome | null)[] = [null, "honest", "annulled"];

  it("«Честный»: из null при вердикте из очереди — применить, при ok и без вердикта — не в разборе", () => {
    expect(decide("honest", { verdict: "suspicious", reviewOutcome: null })).toBe("apply");
    expect(decide("honest", { verdict: "rejected", reviewOutcome: null })).toBe("apply");
    expect(decide("honest", { verdict: "ok", reviewOutcome: null })).toBe("not_in_review");
    expect(decide("honest", { verdict: null, reviewOutcome: null })).toBe("not_in_review");
  });

  it("«Честный»: из honest — тот же ответ, из annulled — отказ с отсылкой к «Вернуть забег»", () => {
    expect(decide("honest", { verdict: "suspicious", reviewOutcome: "honest" })).toBe("same");
    // Вердикт при уже принятом решении не важен: повтор остаётся повтором.
    expect(decide("honest", { verdict: "ok", reviewOutcome: "honest" })).toBe("same");
    expect(decide("honest", { verdict: "suspicious", reviewOutcome: "annulled" })).toBe("already_annulled");
  });

  it("«Аннулировать»: из null и honest — применить (строже), из annulled — тот же ответ; вердикт не важен", () => {
    for (const verdict of ["ok", "suspicious", "rejected", null] as const) {
      expect(decide("annul", { verdict, reviewOutcome: null })).toBe("apply");
      expect(decide("annul", { verdict, reviewOutcome: "honest" })).toBe("apply");
      expect(decide("annul", { verdict, reviewOutcome: "annulled" })).toBe("same");
    }
  });

  it("«Вернуть забег»: из annulled — применить, из honest — тот же ответ, из null — не аннулирован", () => {
    expect(decide("restore", { verdict: "suspicious", reviewOutcome: "annulled" })).toBe("apply");
    expect(decide("restore", { verdict: "suspicious", reviewOutcome: "honest" })).toBe("same");
    expect(decide("restore", { verdict: "suspicious", reviewOutcome: null })).toBe("not_annulled");
    expect(decide("restore", { verdict: "ok", reviewOutcome: null })).toBe("not_annulled");
  });

  it("таблица переходов: куда ведёт действие и откуда разрешено; «Вернуть забег» ставит honest, а не null", () => {
    expect(TRANSITIONS).toEqual({
      honest: { to: "honest", from: [null] },
      annul: { to: "annulled", from: [null, "honest"] },
      restore: { to: "honest", from: ["annulled"] },
    });
    // Всё, что `decide` называет «применить», разрешено таблицей: две части правила не расходятся.
    for (const action of Object.keys(TRANSITIONS) as ReviewAction[]) {
      for (const reviewOutcome of states) {
        if (decide(action, { verdict: "suspicious", reviewOutcome }) === "apply") expect(TRANSITIONS[action].from).toContain(reviewOutcome);
      }
    }
  });

  it("очередь: подозрительные и отклонённые", () => {
    expect(inQueue("suspicious")).toBe(true);
    expect(inQueue("rejected")).toBe(true);
    expect(inQueue("ok")).toBe(false);
    expect(inQueue(null)).toBe(false);
  });

  it("доступные действия по состоянию забега", () => {
    expect(availableActions({ verdict: "suspicious", reviewOutcome: null })).toEqual({ honest: true, annul: true, restore: false });
    expect(availableActions({ verdict: "rejected", reviewOutcome: null })).toEqual({ honest: true, annul: true, restore: false });
    expect(availableActions({ verdict: "suspicious", reviewOutcome: "honest" })).toEqual({ honest: false, annul: true, restore: false });
    expect(availableActions({ verdict: "suspicious", reviewOutcome: "annulled" })).toEqual({ honest: false, annul: false, restore: true });
    expect(availableActions({ verdict: "ok", reviewOutcome: null })).toEqual({ honest: false, annul: true, restore: false });
  });

  it("незнакомое значение колонки — «не разбирался», а не исключение", () => {
    expect(reviewOutcomeOf("weird")).toBeNull();
    expect(reviewOutcomeOf("")).toBeNull();
    expect(reviewOutcomeOf(null)).toBeNull();
    expect(reviewOutcomeOf("honest")).toBe("honest");
    expect(reviewOutcomeOf("annulled")).toBe("annulled");
  });
});

describe("правила разбора: возврат в рейтинг", () => {
  const good = { difficulty: "hard" as const, finishedAt: FINISHED, cheats: false, ratingRestricted: null, mode: "endless" };

  it("рейтинговая сложность после отсечки, без читов и ограничения, не пролог — годен; вердикт не важен", () => {
    expect(returnableToRating(good, SINCE)).toBe(true);
    // Отсечки нет — годен любой законченный забег рейтинговой сложности.
    expect(returnableToRating(good, null)).toBe(true);
    // Забег ровно в момент отсечки — внутри.
    expect(returnableToRating({ ...good, finishedAt: SINCE }, SINCE)).toBe(true);
  });

  it("каждое нарушение по одному — не годен", () => {
    expect(returnableToRating({ ...good, difficulty: "easy" }, SINCE)).toBe(false);
    expect(returnableToRating({ ...good, finishedAt: new Date(SINCE.getTime() - 1) }, SINCE)).toBe(false);
    expect(returnableToRating({ ...good, cheats: true }, SINCE)).toBe(false);
    expect(returnableToRating({ ...good, ratingRestricted: "silent" }, SINCE)).toBe(false);
    expect(returnableToRating({ ...good, ratingRestricted: "notified" }, SINCE)).toBe(false);
    expect(returnableToRating({ ...good, mode: "prologue" }, SINCE)).toBe(false);
  });
});

/** Забег в памяти: репозиторий разбора подменяется целиком, а решения о рейтинге — вызовом `setRanked`. */
class MemoryReviewRepository implements RunReviewRepository {
  readonly rows = new Map<string, RunReportRow>();
  /** Один раз перед `mark` строку меняет «другой вызов»: так воспроизводится проигранная гонка. */
  beforeMark: ((row: RunReportRow) => void) | null = null;
  /** Каждое обновление проигрывает гонку, а строка остаётся прежней: решение никак не удаётся записать. */
  loseEveryMark = false;
  markCalls = 0;

  async report(runId: string): Promise<RunReportRow | null> {
    const row = this.rows.get(runId);
    return row === undefined ? null : { ...row };
  }

  async mark(runId: string, outcome: ReviewOutcome, from: readonly (ReviewOutcome | null)[], actorId: string, at: Date): Promise<boolean> {
    this.markCalls += 1;
    const row = this.rows.get(runId);
    if (row === undefined || this.loseEveryMark) return false;
    const hook = this.beforeMark;
    this.beforeMark = null;
    hook?.(row);
    if (!from.includes(row.reviewOutcome)) return false;
    row.reviewOutcome = outcome;
    row.reviewedAt = at;
    row.reviewedBy = actorId;
    return true;
  }
}

let accounts: MemoryAccountRepository;
let rolesRepository: MemoryRolesRepository;
let repository: MemoryReviewRepository;
let setRanked: ReturnType<typeof vi.fn>;
let service: RunReviewService;
let moderator: AccountRef;
let designer: AccountRef;
let target: AccountRef;

async function player(name: string): Promise<AccountRef> {
  const account = await accounts.upsert({ platform: "telegram", platformUserId: uniquePlatformUserId(), displayName: name, username: null, photoUrl: null }, Date.now());
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

function row(patch: Partial<RunReportRow> = {}): RunReportRow {
  const created: RunReportRow = {
    runId: randomUUID(),
    accountId: target.accountId,
    difficulty: "hard",
    mode: "endless",
    startedAt: new Date(FINISHED.getTime() - 600_000),
    finishedAt: FINISHED,
    outcome: "died",
    survivalSec: 600,
    level: 12,
    enemiesKilled: 900,
    deathCause: "swarm_rat",
    weapons: [{ id: "knife", level: 3, damage: 1200 }],
    details: null,
    continues: [],
    cheats: false,
    contentHash: "abc",
    rubezhReached: false,
    rubezhClearedSec: null,
    verdict: "suspicious",
    verdictReasons: ["kill_rate"],
    ranked: false,
    ratingRestricted: null,
    score: { points: 500, axes: { t: 1, k: 1, h: 1, c: 1, b: 1 }, style: "t", band: "average" },
    scoreInput: null,
    reviewOutcome: null,
    reviewedAt: null,
    reviewedBy: null,
    ...patch,
  };
  repository.rows.set(created.runId, created);
  return created;
}

function build(scorer: RunScorer | null = null): RunReviewService {
  const runs = { setRanked } as unknown as RunsService;
  const rating = { since: () => SINCE } as unknown as RatingRestrictions;
  return new RunReviewService(repository, runs, rating, new RolesService(config(), rolesRepository, accounts), accounts, scorer);
}

beforeEach(async () => {
  accounts = new MemoryAccountRepository();
  rolesRepository = new MemoryRolesRepository();
  repository = new MemoryReviewRepository();
  // Как настоящий `RunsService.setRanked`: меняет рейтинговость строки и отвечает аккаунтом.
  setRanked = vi.fn(async (_actor: AccountRef, runId: string, ranked: boolean, _comment: string) => {
    const stored = repository.rows.get(runId);
    if (stored === undefined) throw new RunNotFoundError();
    stored.ranked = ranked;
    return { accountId: stored.accountId, ranked };
  });
  service = build();
  moderator = await player("Модератор");
  designer = await player("Геймдизайнер");
  target = await player("Игрок");
  await rolesRepository.grant(moderator.accountId, "moderator", null);
  await rolesRepository.grant(designer.accountId, "game_designer", null);
});

function entriesOf(action: string) {
  return rolesRepository.entries.filter((entry) => entry.action === action);
}

describe("отчёт забега", () => {
  it("итог, вердикт, рейтинг, очки, данные подсчёта и состояние разбора — одной формой", async () => {
    const stored = row({ continues: [210.5], rubezhReached: true, rubezhClearedSec: 640, scoreInput: { power: 12, huntLog: null, buildScore: 3 } });
    const scorer = { expectedPointsFor: (index: number) => 700 + index } as unknown as RunScorer;

    const view = await build(scorer).report(moderator, stored.runId);

    expect(view).toEqual({
      runId: stored.runId,
      accountId: target.accountId,
      displayName: "Игрок",
      difficulty: "hard",
      mode: "endless",
      startedAt: new Date(FINISHED.getTime() - 600_000).toISOString(),
      finishedAt: FINISHED.toISOString(),
      outcome: "died",
      survivalSec: 600,
      level: 12,
      enemiesKilled: 900,
      deathCause: "swarm_rat",
      weapons: [{ id: "knife", level: 3, damage: 1200 }],
      details: null,
      continues: [210.5],
      cheats: false,
      contentHash: "abc",
      rubezh: { reached: true, clearedSec: 640 },
      verdict: "suspicious",
      verdictReasons: ["kill_rate"],
      rating: { ranked: false, ratingRestricted: null, returnable: true },
      score: { points: 500, axes: { t: 1, k: 1, h: 1, c: 1, b: 1 }, style: "t", band: "average", expectedPoints: 701 },
      scoreInput: { power: 12, huntLog: null, buildScore: 3 },
      review: { outcome: null, reviewedAt: null, reviewedBy: null, reviewerName: null },
      actions: { honest: true, annul: true, restore: false },
    });
  });

  it("нет подсчёта очков или самих очков — expectedPoints и score равны null", async () => {
    const scored = row();
    expect((await service.report(moderator, scored.runId)).score).toMatchObject({ points: 500, expectedPoints: null });
    const unscored = row({ score: null });
    expect((await service.report(moderator, unscored.runId)).score).toBeNull();
  });

  it("с решением: кто и когда решил — время в ISO и имя из аккаунта", async () => {
    const at = new Date("2026-11-06T09:30:00.000Z");
    const stored = row({ reviewOutcome: "honest", reviewedAt: at, reviewedBy: moderator.accountId });

    const view = await service.report(designer, stored.runId);

    expect(view.review).toEqual({ outcome: "honest", reviewedAt: at.toISOString(), reviewedBy: moderator.accountId, reviewerName: "Модератор" });
    expect(view.actions).toEqual({ honest: false, annul: true, restore: false });
  });

  it("тот, кто решил, удалён — имени нет, отчёт читается", async () => {
    const stored = row({ reviewOutcome: "annulled", reviewedAt: FINISHED, reviewedBy: randomUUID() });

    const view = await service.report(moderator, stored.runId);

    expect(view.review.reviewerName).toBeNull();
    expect(view.actions.restore).toBe(true);
  });

  it("отчёт открывается с правом players.view; без права — 403; нет забега — 404", async () => {
    const stored = row();
    const stranger = await player("Чужой");
    await rolesRepository.grant(stranger.accountId, "analyst", null);

    await expect(service.report(designer, stored.runId)).resolves.toMatchObject({ runId: stored.runId });
    await expect(service.report(stranger, stored.runId)).rejects.toMatchObject({ status: 403 });
    await expect(service.report(moderator, randomUUID())).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it("негодный для рейтинга забег — returnable: false", async () => {
    const stored = row({ cheats: true });
    expect((await service.report(moderator, stored.runId)).rating.returnable).toBe(false);
  });
});

describe("«Честный»", () => {
  it("годный подозрительный забег: решение записано, rank — тем же путём, что «Вернуть…», ровно один раз", async () => {
    const stored = row();

    const view = await service.honest(moderator, stored.runId, null);

    expect(setRanked).toHaveBeenCalledTimes(1);
    expect(setRanked).toHaveBeenCalledWith(moderator, stored.runId, true, DEFAULT_COMMENT);
    expect(repository.rows.get(stored.runId)).toMatchObject({ reviewOutcome: "honest", reviewedBy: moderator.accountId });
    expect(view.review).toMatchObject({ outcome: "honest", reviewedBy: moderator.accountId, reviewerName: "Модератор" });
    expect(view.rating).toEqual({ ranked: true, ratingRestricted: null, returnable: true });
    expect(view.actions).toEqual({ honest: false, annul: true, restore: false });
    expect(entriesOf("players.run.honest")).toHaveLength(1);
    expect(entriesOf("players.run.honest")[0]).toMatchObject({
      actorAccountId: moderator.accountId,
      target: target.accountId,
      after: { runId: stored.runId, verdict: "suspicious", reasons: ["kill_rate"] },
    });
  });

  it("с причиной — она уходит в setRanked и в журнал", async () => {
    const stored = row({ verdict: "rejected" });

    await service.honest(moderator, stored.runId, "Смотрел повтор, чисто");

    expect(setRanked).toHaveBeenCalledWith(moderator, stored.runId, true, "Смотрел повтор, чисто");
    expect(entriesOf("players.run.honest")[0]).toMatchObject({ after: { comment: "Смотрел повтор, чисто", verdict: "rejected" } });
  });

  it.each([
    ["с читами", { cheats: true }],
    ["сдан под ограничением рейтинга", { ratingRestricted: "silent" as const }],
    ["нерейтинговой сложности", { difficulty: "easy" as const }],
    ["раньше отсечки рейтинга", { finishedAt: new Date(SINCE.getTime() - 1000) }],
    ["пролог", { mode: "prologue" as const }],
  ])("негодный забег (%s): с очереди снимается, в рейтинг не возвращается", async (_title, patch) => {
    const stored = row(patch);

    const view = await service.honest(moderator, stored.runId, null);

    expect(setRanked).not.toHaveBeenCalled();
    expect(view.review.outcome).toBe("honest");
    expect(view.rating).toMatchObject({ ranked: false, returnable: false });
    expect(entriesOf("players.run.honest")).toHaveLength(1);
    expect(entriesOf("players.run.rerank")).toHaveLength(0);
  });

  it("setRanked ответил RunRankingConflictError — это не ошибка решения: rating.ranked остаётся как в базе", async () => {
    const stored = row();
    setRanked.mockRejectedValueOnce(new RunRankingConflictError(true));

    const view = await service.honest(moderator, stored.runId, null);

    expect(view.review.outcome).toBe("honest");
    expect(view.rating.ranked).toBe(false);
    expect(entriesOf("players.run.honest")).toHaveLength(1);
  });

  it("другая ошибка setRanked летит дальше, а решение уже записано", async () => {
    const stored = row();
    setRanked.mockRejectedValueOnce(new Error("redis недоступен"));

    await expect(service.honest(moderator, stored.runId, null)).rejects.toThrow("redis недоступен");

    expect(repository.rows.get(stored.runId)?.reviewOutcome).toBe("honest");
    expect(entriesOf("players.run.honest")).toHaveLength(1);
  });

  it("повтор — тот же ответ, журнал пишется один раз, setRanked не зван", async () => {
    const stored = row();
    await service.honest(moderator, stored.runId, null);
    setRanked.mockClear();

    const again = await service.honest(moderator, stored.runId, "ещё раз");

    expect(again.review.outcome).toBe("honest");
    expect(setRanked).not.toHaveBeenCalled();
    expect(entriesOf("players.run.honest")).toHaveLength(1);
  });

  it("забег с вердиктом ok — 409 «не в разборе», строка не меняется", async () => {
    const stored = row({ verdict: "ok", verdictReasons: [] });

    await expect(service.honest(moderator, stored.runId, null)).rejects.toMatchObject({ status: 409, message: "Забег не в разборе: проверка не нашла в нём вопросов" });

    expect(repository.markCalls).toBe(0);
    expect(setRanked).not.toHaveBeenCalled();
  });

  it("аннулированный — 409 с отсылкой к «Вернуть забег», без записей", async () => {
    const stored = row({ reviewOutcome: "annulled", reviewedAt: FINISHED, reviewedBy: moderator.accountId });

    await expect(service.honest(moderator, stored.runId, null)).rejects.toMatchObject({ status: 409, message: "Забег аннулирован — вернуть его можно кнопкой «Вернуть забег»" });

    expect(entriesOf("players.run.honest")).toHaveLength(0);
    expect(setRanked).not.toHaveBeenCalled();
  });

  it("без players.restrict — 403 и ничего не записано; нет забега — 404", async () => {
    const stored = row();

    await expect(service.honest(designer, stored.runId, null)).rejects.toMatchObject({ status: 403 });
    await expect(service.honest(moderator, randomUUID(), null)).rejects.toBeInstanceOf(RunNotFoundError);

    expect(repository.markCalls).toBe(0);
    expect(entriesOf("players.run.honest")).toHaveLength(0);
  });

  it("проиграл гонку: другой вызов уже сделал забег честным — тот же ответ без записи и setRanked", async () => {
    const stored = row();
    repository.beforeMark = (current) => {
      current.reviewOutcome = "honest";
    };

    const view = await service.honest(moderator, stored.runId, null);

    expect(view.review.outcome).toBe("honest");
    expect(setRanked).not.toHaveBeenCalled();
    expect(entriesOf("players.run.honest")).toHaveLength(0);
  });

  it("проиграл гонку: другой вызов успел аннулировать — 409", async () => {
    const stored = row();
    repository.beforeMark = (current) => {
      current.reviewOutcome = "annulled";
    };

    await expect(service.honest(moderator, stored.runId, null)).rejects.toMatchObject({ status: 409 });

    expect(entriesOf("players.run.honest")).toHaveLength(0);
    expect(setRanked).not.toHaveBeenCalled();
  });

  it("гонка проиграна во всех трёх попытках — 409 run_review_busy, записи в журнал и setRanked нет", async () => {
    const stored = row();
    repository.loseEveryMark = true;

    await expect(service.honest(moderator, stored.runId, null)).rejects.toMatchObject({ status: 409, code: "run_review_busy" });

    expect(repository.markCalls).toBe(3);
    expect(repository.rows.get(stored.runId)?.reviewOutcome).toBeNull();
    expect(entriesOf("players.run.honest")).toHaveLength(0);
    expect(setRanked).not.toHaveBeenCalled();
  });

  it("текст run_review_busy без повелительного обращения: файл вне TEAM_PATHS, тест на «ты» (Р163) считает его игровым", async () => {
    const stored = row();
    repository.loseEveryMark = true;

    const error: unknown = await service.honest(moderator, stored.runId, null).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toBe("Забег решают одновременно — отчёт нужно открыть заново");
    expect(message).not.toMatch(/\p{L}+(ите|йте)(?!\p{L})/u);
  });
});

describe("«Аннулировать»", () => {
  it("рейтинговый забег: решение, снятие тем же путём, что «Не учитывать…», ровно один раз; журнал с wasRanked", async () => {
    const stored = row({ verdict: "ok", verdictReasons: [], ranked: true });

    const view = await service.annul(moderator, stored.runId, "накрутка");

    expect(setRanked).toHaveBeenCalledTimes(1);
    expect(setRanked).toHaveBeenCalledWith(moderator, stored.runId, false, "накрутка");
    expect(view.review.outcome).toBe("annulled");
    expect(view.rating.ranked).toBe(false);
    expect(view.actions).toEqual({ honest: false, annul: false, restore: true });
    expect(entriesOf("players.run.annul")).toHaveLength(1);
    const entry = entriesOf("players.run.annul")[0];
    expect(entry).toMatchObject({ actorAccountId: moderator.accountId, target: target.accountId, after: { runId: stored.runId, verdict: "ok", reasons: [], comment: "накрутка", wasRanked: true } });
    expect(entry?.before).toBeUndefined();
  });

  it("нерейтинговый забег: решение записано, setRanked не зван, wasRanked: false", async () => {
    const stored = row();

    const view = await service.annul(moderator, stored.runId, "не наш");

    expect(setRanked).not.toHaveBeenCalled();
    expect(view.review.outcome).toBe("annulled");
    expect(entriesOf("players.run.annul")[0]).toMatchObject({ after: { wasRanked: false } });
  });

  it("из honest — строже; журнал помнит прежнее состояние", async () => {
    const stored = row({ reviewOutcome: "honest", reviewedAt: FINISHED, reviewedBy: moderator.accountId, ranked: true });

    await service.annul(moderator, stored.runId, "передумали");

    expect(repository.rows.get(stored.runId)?.reviewOutcome).toBe("annulled");
    expect(setRanked).toHaveBeenCalledWith(moderator, stored.runId, false, "передумали");
    expect(entriesOf("players.run.annul")[0]).toMatchObject({ before: { reviewOutcome: "honest" }, after: { wasRanked: true } });
  });

  it("RunRankingConflictError из setRanked — не ошибка аннулирования: забег уже вне досок", async () => {
    const stored = row({ ranked: true });
    setRanked.mockRejectedValueOnce(new RunRankingConflictError(false));

    const view = await service.annul(moderator, stored.runId, "причина");

    expect(view.review.outcome).toBe("annulled");
    expect(entriesOf("players.run.annul")).toHaveLength(1);
  });

  it("другая ошибка setRanked летит дальше, а решение записано", async () => {
    const stored = row({ ranked: true });
    setRanked.mockRejectedValueOnce(new Error("redis недоступен"));

    await expect(service.annul(moderator, stored.runId, "причина")).rejects.toThrow("redis недоступен");

    expect(repository.rows.get(stored.runId)?.reviewOutcome).toBe("annulled");
  });

  it("повтор уже аннулированного, но ещё рейтингового забега: снимает с рейтинга и не пишет второй players.run.annul", async () => {
    const stored = row({ reviewOutcome: "annulled", reviewedAt: FINISHED, reviewedBy: moderator.accountId, ranked: true });

    const view = await service.annul(moderator, stored.runId, "добиваем");

    expect(setRanked).toHaveBeenCalledTimes(1);
    expect(setRanked).toHaveBeenCalledWith(moderator, stored.runId, false, "добиваем");
    expect(view.rating.ranked).toBe(false);
    expect(entriesOf("players.run.annul")).toHaveLength(0);
  });

  it("повтор аннулированного и уже снятого — тот же ответ без записей и без setRanked", async () => {
    const stored = row();
    await service.annul(moderator, stored.runId, "первый раз");
    setRanked.mockClear();

    const again = await service.annul(moderator, stored.runId, "второй раз");

    expect(again.review.outcome).toBe("annulled");
    expect(setRanked).not.toHaveBeenCalled();
    expect(entriesOf("players.run.annul")).toHaveLength(1);
  });

  it("для любого законченного забега: и с вердиктом ok, и без вердикта", async () => {
    const withoutVerdict = row({ verdict: null, verdictReasons: [] });

    expect((await service.annul(moderator, withoutVerdict.runId, "по ссылке")).review.outcome).toBe("annulled");
  });

  it("без players.restrict — 403; нет забега — 404", async () => {
    const stored = row({ ranked: true });

    await expect(service.annul(designer, stored.runId, "нельзя")).rejects.toMatchObject({ status: 403 });
    await expect(service.annul(moderator, randomUUID(), "нет такого")).rejects.toBeInstanceOf(RunNotFoundError);

    expect(repository.rows.get(stored.runId)?.reviewOutcome).toBeNull();
    expect(setRanked).not.toHaveBeenCalled();
  });

  it("проиграл гонку: другой вызов уже аннулировал — ответ тот же, запись одна; setRanked — по нынешней строке", async () => {
    const stored = row({ ranked: true });
    repository.beforeMark = (current) => {
      current.reviewOutcome = "annulled";
      current.reviewedAt = FINISHED;
      current.reviewedBy = designer.accountId;
    };

    const view = await service.annul(moderator, stored.runId, "параллельно");

    expect(view.review.outcome).toBe("annulled");
    expect(entriesOf("players.run.annul")).toHaveLength(0);
    // Строка при перечитывании всё ещё рейтинговая — снять её доведёт проигравший (повтор чинит недоделанное).
    expect(setRanked).toHaveBeenCalledTimes(1);
  });
});

describe("«Вернуть забег»", () => {
  it("аннулированный годный забег: в honest из annulled, setRanked(true) один раз, журнал с before", async () => {
    const stored = row({ verdict: "ok", verdictReasons: [], reviewOutcome: "annulled", reviewedAt: FINISHED, reviewedBy: designer.accountId });

    const view = await service.restore(moderator, stored.runId, "ошиблись, он честный");

    expect(repository.rows.get(stored.runId)).toMatchObject({ reviewOutcome: "honest", reviewedBy: moderator.accountId });
    expect(setRanked).toHaveBeenCalledTimes(1);
    expect(setRanked).toHaveBeenCalledWith(moderator, stored.runId, true, "ошиблись, он честный");
    expect(view.review).toMatchObject({ outcome: "honest", reviewerName: "Модератор" });
    expect(view.rating.ranked).toBe(true);
    expect(view.actions).toEqual({ honest: false, annul: true, restore: false });
    expect(entriesOf("players.run.restore")).toHaveLength(1);
    expect(entriesOf("players.run.restore")[0]).toMatchObject({
      actorAccountId: moderator.accountId,
      target: target.accountId,
      before: { reviewOutcome: "annulled" },
      after: { runId: stored.runId, verdict: "ok", comment: "ошиблись, он честный" },
    });
  });

  it("подозрительный забег в honest не возвращается в очередь: решение «честный», а не «не разбирался»", async () => {
    const stored = row({ reviewOutcome: "annulled", reviewedAt: FINISHED, reviewedBy: designer.accountId });

    await service.restore(moderator, stored.runId, "разобрались");

    expect(repository.rows.get(stored.runId)?.reviewOutcome).toBe("honest");
  });

  it("негодный для рейтинга забег (читы): решение записано, setRanked не зван", async () => {
    const stored = row({ cheats: true, reviewOutcome: "annulled", reviewedAt: FINISHED, reviewedBy: designer.accountId });

    const view = await service.restore(moderator, stored.runId, "разобрались");

    expect(view.review.outcome).toBe("honest");
    expect(view.rating).toMatchObject({ ranked: false, returnable: false });
    expect(setRanked).not.toHaveBeenCalled();
  });

  it("RunRankingConflictError из setRanked — не ошибка возврата", async () => {
    const stored = row({ reviewOutcome: "annulled", reviewedAt: FINISHED, reviewedBy: designer.accountId });
    setRanked.mockRejectedValueOnce(new RunRankingConflictError(true));

    const view = await service.restore(moderator, stored.runId, "разобрались");

    expect(view.review.outcome).toBe("honest");
    expect(view.rating.ranked).toBe(false);
  });

  it("повтор на honest — тот же ответ, без setRanked и без второй записи", async () => {
    const stored = row({ reviewOutcome: "annulled", reviewedAt: FINISHED, reviewedBy: designer.accountId });
    await service.restore(moderator, stored.runId, "первый раз");
    setRanked.mockClear();

    const again = await service.restore(moderator, stored.runId, "второй раз");

    expect(again.review.outcome).toBe("honest");
    expect(setRanked).not.toHaveBeenCalled();
    expect(entriesOf("players.run.restore")).toHaveLength(1);
  });

  it("неразобранный — 409 «возвращать нечего»", async () => {
    const stored = row();

    await expect(service.restore(moderator, stored.runId, "зачем")).rejects.toMatchObject({ status: 409, message: "Забег не аннулирован — возвращать нечего" });

    expect(repository.markCalls).toBe(0);
    expect(setRanked).not.toHaveBeenCalled();
  });

  it("без players.restrict — 403; нет забега — 404", async () => {
    const stored = row({ reviewOutcome: "annulled", reviewedAt: FINISHED, reviewedBy: designer.accountId });

    await expect(service.restore(designer, stored.runId, "нельзя")).rejects.toMatchObject({ status: 403 });
    await expect(service.restore(moderator, randomUUID(), "нет такого")).rejects.toBeInstanceOf(RunNotFoundError);

    expect(repository.rows.get(stored.runId)?.reviewOutcome).toBe("annulled");
  });

  it("проиграл гонку: другой вызов уже вернул забег — тот же ответ, setRanked не зван", async () => {
    const stored = row({ reviewOutcome: "annulled", reviewedAt: FINISHED, reviewedBy: designer.accountId });
    repository.beforeMark = (current) => {
      current.reviewOutcome = "honest";
    };

    const view = await service.restore(moderator, stored.runId, "параллельно");

    expect(view.review.outcome).toBe("honest");
    expect(setRanked).not.toHaveBeenCalled();
    expect(entriesOf("players.run.restore")).toHaveLength(0);
  });
});

describe("разбор по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const headers = { cookie: `${ADMIN_SESSION_COOKIE}=mod`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
  const viewerHeaders = { cookie: `${ADMIN_SESSION_COOKIE}=gd`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
  const strangerHeaders = { cookie: `${ADMIN_SESSION_COOKIE}=an`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };

  beforeEach(async () => {
    const store = new MemoryAdminSessionStore();
    const analyst = await player("Аналитик");
    await rolesRepository.grant(analyst.accountId, "analyst", null);
    await store.put(hashSessionToken("mod"), { ...moderator, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    await store.put(hashSessionToken("gd"), { ...designer, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    await store.put(hashSessionToken("an"), { ...analyst, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });

    @Module({
      controllers: [AdminRunReviewController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: rolesRepository },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: RUN_REVIEW_REPOSITORY, useValue: repository },
        { provide: RunReviewService, useValue: service },
        RateLimiter,
        RolesService,
        PermissionGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function post(runId: string, action: string, payload: unknown, as: Record<string, string> = headers) {
    return await (app as NestFastifyApplication).inject({ method: "POST", url: `/api/v1/admin/runs/${runId}/${action}`, headers: as, payload: payload as Record<string, unknown> });
  }

  it("GET report с players.view — 200 и форма отчёта с rating.returnable и actions.restore", async () => {
    const stored = row();

    const response = await (app as NestFastifyApplication).inject({ method: "GET", url: `/api/v1/admin/runs/${stored.runId}/report`, headers: viewerHeaders });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      runId: stored.runId,
      displayName: "Игрок",
      verdict: "suspicious",
      verdictReasons: ["kill_rate"],
      rating: { ranked: false, ratingRestricted: null, returnable: true },
      review: { outcome: null, reviewedAt: null, reviewedBy: null, reviewerName: null },
      actions: { honest: true, annul: true, restore: false },
    });
  });

  it("GET report без права — 403; незнакомый runId — 404; слишком короткий — 400", async () => {
    const stored = row();
    const url = (id: string) => `/api/v1/admin/runs/${id}/report`;

    expect((await (app as NestFastifyApplication).inject({ method: "GET", url: url(stored.runId), headers: strangerHeaders })).statusCode).toBe(403);
    expect((await (app as NestFastifyApplication).inject({ method: "GET", url: url(randomUUID()), headers })).statusCode).toBe(404);
    expect((await (app as NestFastifyApplication).inject({ method: "GET", url: url("short"), headers })).statusCode).toBe(400);
  });

  it("решения с players.view без players.restrict — 403", async () => {
    const stored = row();

    expect((await post(stored.runId, "honest", {}, viewerHeaders)).statusCode).toBe(403);
    expect((await post(stored.runId, "annul", { comment: "нельзя" }, viewerHeaders)).statusCode).toBe(403);
    expect((await post(stored.runId, "restore", { comment: "нельзя" }, viewerHeaders)).statusCode).toBe(403);
    expect(repository.markCalls).toBe(0);
  });

  it("annul и restore без причины или с пустой — 400 «Нужна причина»; лишнее поле — 400", async () => {
    const stored = row();

    for (const action of ["annul", "restore"]) {
      for (const payload of [{}, { comment: "" }, { comment: "   " }, { comment: "причина", extra: 1 }]) {
        const response = await post(stored.runId, action, payload);
        expect(response.statusCode, `${action} ${JSON.stringify(payload)}`).toBe(400);
        expect(response.json().error.message).toBe("Нужна причина");
      }
    }
    expect(repository.markCalls).toBe(0);
  });

  it("honest: причина необязательна, но если задана — от 1 до 500 знаков; лишнее поле — 400", async () => {
    const stored = row();

    for (const payload of [{ comment: "" }, { comment: "я".repeat(501) }, { extra: true }]) {
      const response = await post(stored.runId, "honest", payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error.message).toBe("Причина — от 1 до 500 знаков");
    }
    expect(repository.markCalls).toBe(0);

    const done = await post(stored.runId, "honest", {});
    expect(done.statusCode).toBe(200);
    expect(done.json().data.review.outcome).toBe("honest");
  });

  it("annul: 200 и свежий отчёт; повтор — тоже 200 и та же запись", async () => {
    const stored = row({ verdict: "ok", verdictReasons: [], ranked: true });

    const first = await post(stored.runId, "annul", { comment: "накрутка" });
    const again = await post(stored.runId, "annul", { comment: "ещё раз" });

    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ review: { outcome: "annulled" }, rating: { ranked: false }, actions: { honest: false, annul: false, restore: true } });
    expect(again.statusCode).toBe(200);
    expect(entriesOf("players.run.annul")).toHaveLength(1);
  });

  it("restore: 200 и забег снова честный", async () => {
    const stored = row({ reviewOutcome: "annulled", reviewedAt: FINISHED, reviewedBy: designer.accountId });

    const response = await post(stored.runId, "restore", { comment: "ошиблись" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ review: { outcome: "honest" }, rating: { ranked: true } });
  });

  it("409: honest на ok-забеге; honest на аннулированном — с текстом про «Вернуть забег»; restore на неразобранном", async () => {
    const clean = row({ verdict: "ok", verdictReasons: [] });
    const annulled = row({ reviewOutcome: "annulled", reviewedAt: FINISHED, reviewedBy: designer.accountId });
    const open = row();

    const notInReview = await post(clean.runId, "honest", {});
    const wasAnnulled = await post(annulled.runId, "honest", {});
    const notAnnulled = await post(open.runId, "restore", { comment: "зачем" });

    expect(notInReview.statusCode).toBe(409);
    expect(wasAnnulled.statusCode).toBe(409);
    expect(wasAnnulled.json().error.message).toContain("Вернуть забег");
    expect(notAnnulled.statusCode).toBe(409);
    expect(notAnnulled.json().error.message).toBe("Забег не аннулирован — возвращать нечего");
  });

  it("незнакомый runId — 404 у каждого решения; слишком короткий — 400", async () => {
    expect((await post(randomUUID(), "honest", {})).statusCode).toBe(404);
    expect((await post(randomUUID(), "annul", { comment: "нет" })).statusCode).toBe(404);
    expect((await post(randomUUID(), "restore", { comment: "нет" })).statusCode).toBe(404);
    expect((await post("short", "annul", { comment: "нет" })).statusCode).toBe(400);
  });
});
