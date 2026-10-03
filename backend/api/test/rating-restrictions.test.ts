import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminRunsController } from "../src/modules/admin/admin-runs.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { RestrictionsService } from "../src/modules/restrictions/restrictions.service.js";
import type { ImposeInput } from "../src/modules/restrictions/restriction-rules.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import type { RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunExtras } from "../src/modules/runs/run-details.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, MemoryRunsRepository, ratingRestrictions } from "./helpers/memory-runs.js";

/**
 * Ограничение рейтинга (docs/35-stage4-plan.md WP44, О40): игрок пропадает
 * из досок сразу, забеги за срок не засчитываются ни тогда, ни потом, а по
 * сроку он возвращается с лучшим забегом до ограничения — без участия
 * команды. Молчаливое — тень: себя игрок видит на своём месте, другие его
 * не видят.
 */

const DAY = 86_400_000;
const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

function finish(patch: Partial<RunFinish> = {}): RunFinish {
  return {
    runId: randomUUID(),
    difficultyId: "normal",
    outcome: "died",
    survivalSec: 120,
    level: 6,
    enemiesKilled: 300,
    startingWeaponId: "knife",
    weapons: [{ id: "knife", level: 2 }],
    contentHash: "abc",
    deathCause: "swarm_rat",
    cheats: false,
    countInRating: false,
    continues: [],
    boosts: [],
    passives: [],
    ...patch,
  };
}

let accounts: MemoryAccountRepository;
let runs: MemoryRunsRepository;
let board: MemoryLeaderboardStore;
let rating: ReturnType<typeof ratingRestrictions>;
let restrictions: RestrictionsService;
let service: RunsService;
let view: RunsViewService;
let moderator: AccountRef;
let rolesRepository: MemoryRolesRepository;

beforeEach(async () => {
  accounts = new MemoryAccountRepository();
  runs = new MemoryRunsRepository();
  board = new MemoryLeaderboardStore();
  rating = ratingRestrictions(runs, board);
  rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(config(), rolesRepository, accounts);
  restrictions = new RestrictionsService(rating.restrictions, accounts, roles, rating.gate, rating.hooks);
  service = new RunsService(config(), runs, board, roles, new RunsHooks(), new RunContinues(), new RunLoadouts(), rating.rating);
  view = new RunsViewService(runs, board, new RunExtras(), rating.rating);
  moderator = await player("модератор");
  await rolesRepository.grant(moderator.accountId, "moderator", null);
});

async function player(name: string): Promise<AccountRef> {
  const account = await accounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e9)), displayName: name, username: null, photoUrl: null }, Date.now());
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

function input(patch: Partial<ImposeInput> = {}): ImposeInput {
  return { kinds: ["leaderboard"], endsAt: null, reason: "leaderboard_cheat", comment: null, notify: true, ...patch };
}

describe("ограничение рейтинга, о котором сообщили", () => {
  it("на три дня: из досок — сразу, забеги за срок не в счёт, по сроку — назад с лучшим до ограничения", async () => {
    const [cheater, honest] = [await player("Ловкач"), await player("Честный")];
    await service.finish(cheater, finish({ survivalSec: 300 }));
    await service.finish(honest, finish({ survivalSec: 200 }));
    const now = Date.now();
    await restrictions.impose(moderator, cheater.accountId, input({ endsAt: new Date(now + 3 * DAY).toISOString() }), new Date(now));

    expect(await board.best("normal", cheater.accountId)).toBeNull();
    const seen = await view.leaderboardFor(honest.accountId, "normal");
    expect(seen.entries.map((entry) => [entry.rank, entry.survivalSec, entry.isMe])).toEqual([[1, 200, true]]);
    expect(seen.totalPlayers).toBe(1);

    const during = finish({ survivalSec: 500 });
    expect(await service.finish(cheater, during, now + DAY)).toMatchObject({ recorded: false, verdict: "ok", isNewBest: false, rank: null });
    expect(runs.rows.get(during.runId)).toMatchObject({ ranked: false, ratingRestricted: "notified" });
    expect((await view.detail(cheater.accountId, during.runId)).rating).toBe("restricted");
    expect((await view.leaderboardFor(cheater.accountId, "normal")).me).toBeNull();
    expect((await view.profile(cheater.accountId)).best.normal).toBeNull();

    // Срок вышел — задача возвращает лучший забег до ограничения, а не за срок.
    expect(await restrictions.settleDue(new Date(now + 3 * DAY + 60_000))).toBe(1);
    expect(await board.best("normal", cheater.accountId)).toBe(300);
    expect(await board.rank("normal", cheater.accountId)).toBe(1);
    // Новые забеги — снова в рейтинг.
    expect(await service.finish(cheater, finish({ survivalSec: 400 }), now + 3 * DAY + 120_000)).toMatchObject({ recorded: true, isNewBest: true, rank: 1 });
  });

  it("снятие раньше срока возвращает в доску сразу; повтор итога рейтингового забега после наложения в доску не пишет", async () => {
    const target = await player("Игрок");
    const first = finish({ survivalSec: 250 });
    await service.finish(target, first);
    const [imposed] = await restrictions.impose(moderator, target.accountId, input());

    // Клиент повторил итог из очереди уже после наложения.
    expect(await service.finish(target, first)).toMatchObject({ recorded: true, rank: null });
    expect(await board.best("normal", target.accountId)).toBeNull();

    await restrictions.lift(moderator, imposed?.restrictionId ?? "", "разобрались — честный");
    expect(await board.best("normal", target.accountId)).toBe(250);
  });

  it("блокировка целиком тоже убирает из досок; снятие одного вида при другом действующем в доску не возвращает", async () => {
    const target = await player("Игрок");
    await service.finish(target, finish({ survivalSec: 250 }));
    const [restricted] = await restrictions.impose(moderator, target.accountId, input());
    const [banned] = await restrictions.impose(moderator, target.accountId, input({ kinds: ["all"], reason: "abuse" }));

    await restrictions.lift(moderator, restricted?.restrictionId ?? "", "рейтинг — по ошибке");
    expect(await board.best("normal", target.accountId)).toBeNull();
    await restrictions.lift(moderator, banned?.restrictionId ?? "", "блокировка — по ошибке");
    expect(await board.best("normal", target.accountId)).toBe(250);
  });
});

describe("тень: ограничение рейтинга молча", () => {
  it("игрок видит себя на своём месте и рекорд как обычно, другие его не видят; по снятию — лучший до тени", async () => {
    const [leader, third, shadow] = [await player("Лидер"), await player("Третий"), await player("Тень")];
    await service.finish(leader, finish({ survivalSec: 600 }));
    await service.finish(third, finish({ survivalSec: 300 }));
    await service.finish(shadow, finish({ survivalSec: 200 }));
    const [imposed] = await restrictions.impose(moderator, shadow.accountId, input({ notify: false }));

    const run = finish({ survivalSec: 400 });
    expect(await service.finish(shadow, run)).toEqual({ recorded: true, verdict: "ok", bestSurvivalSec: 400, isNewBest: true, rank: 2 });
    expect(runs.rows.get(run.runId)).toMatchObject({ ranked: false, ratingRestricted: "silent" });
    expect(await board.best("normal", shadow.accountId)).toBeNull();

    const mine = await view.leaderboardFor(shadow.accountId, "normal");
    expect(mine.entries.map((entry) => [entry.rank, entry.survivalSec, entry.isMe])).toEqual([
      [1, 600, false],
      [2, 400, true],
      [3, 300, false],
    ]);
    expect(mine.me).toEqual({ rank: 2, survivalSec: 400 });
    expect(mine.totalPlayers).toBe(3);
    // Карточка `/start` считает доску так же: место 2 из 3, а не из 2.
    expect(await view.boardSize(shadow.accountId, "normal")).toBe(3);
    expect(await view.boardSize(third.accountId, "normal")).toBe(2);
    const theirs = await view.leaderboardFor(third.accountId, "normal");
    expect(theirs.entries.map((entry) => [entry.rank, entry.survivalSec, entry.isMe])).toEqual([
      [1, 600, false],
      [2, 300, true],
    ]);
    expect(theirs.totalPlayers).toBe(2);
    expect((await view.profile(shadow.accountId)).best.normal).toEqual({ survivalSec: 400, rank: 2 });
    // Команда в карточке игрока видит правду: в доске его нет.
    expect((await view.profile(shadow.accountId, "team")).best.normal).toBeNull();
    expect((await view.detail(shadow.accountId, run.runId)).rating).toBe("ranked");

    // Повтор итога рекордом не называется; худший забег рекорд не опускает.
    expect(await service.finish(shadow, run)).toMatchObject({ isNewBest: false, rank: 2, bestSurvivalSec: 400 });
    expect(await service.finish(shadow, finish({ survivalSec: 100 }))).toMatchObject({ isNewBest: false, bestSurvivalSec: 400 });

    await restrictions.lift(moderator, imposed?.restrictionId ?? "", "достаточно");
    expect(await board.best("normal", shadow.accountId)).toBe(200);
  });

  it("в тени без единого забега — себя в доске нет, как у любого без забегов", async () => {
    const [other, shadow] = [await player("Другой"), await player("Тень")];
    await service.finish(other, finish());
    await restrictions.impose(moderator, shadow.accountId, input({ notify: false }));

    const seen = await view.leaderboardFor(shadow.accountId, "normal");
    expect(seen.me).toBeNull();
    expect(seen.entries.map((entry) => [entry.survivalSec, entry.isMe])).toEqual([[120, false]]);
    expect(seen.totalPlayers).toBe(1);
  });
});

describe("последствия догоняют сбои", () => {
  it("обход раз в минуту убирает из доски того, кто вернулся в неё гонкой; занятый лок — пропуск", async () => {
    const target = await player("Игрок");
    await restrictions.impose(moderator, target.accountId, input());
    // Итог, принятый в ту же секунду, что наложение, успел записать место.
    await board.submit("normal", target.accountId, 300);

    expect(await rating.rating.tick()).toBe(1);
    expect(await board.best("normal", target.accountId)).toBeNull();
    expect(await rating.rating.tick()).toBe(0);
    rating.lock.held = true;
    expect(await rating.rating.tick()).toBeNull();
  });

  it("пересборка рейтинга из базы ограниченного не возвращает", async () => {
    const [target, other] = [await player("Игрок"), await player("Другой")];
    await service.finish(target, finish({ survivalSec: 300 }));
    await service.finish(other, finish({ survivalSec: 200 }));
    await restrictions.impose(moderator, target.accountId, input({ notify: false }));

    expect((await service.rebuildLeaderboard()).normal).toBe(1);
    expect(await board.best("normal", target.accountId)).toBeNull();
    expect(await board.best("normal", other.accountId)).toBe(200);
  });

  it("не вернулось в доску — ограничение не сведено, и задача по сроку повторит", async () => {
    const target = await player("Игрок");
    await service.finish(target, finish({ survivalSec: 300 }));
    const now = Date.now();
    await restrictions.impose(moderator, target.accountId, input({ endsAt: new Date(now + DAY).toISOString() }), new Date(now));

    board.failSubmit = true;
    await restrictions.settleDue(new Date(now + DAY + 1));
    expect(rating.restrictions.rows[0]?.settledAt).toBeNull();
    expect(await board.best("normal", target.accountId)).toBeNull();

    board.failSubmit = false;
    expect(await restrictions.settleDue(new Date(now + DAY + 60_000))).toBe(1);
    expect(await board.best("normal", target.accountId)).toBe(300);
    expect(rating.restrictions.rows[0]?.settledAt).not.toBeNull();
  });
});

describe("модератор снимает забег с рейтинга (часть 3б)", () => {
  it("снятый рекорд уходит из доски, место — по следующему лучшему; вернуть — назад; всё в аудите", async () => {
    const [cheater, other] = [await player("Ловкач"), await player("Другой")];
    const record = finish({ survivalSec: 500 });
    await service.finish(cheater, record);
    await service.finish(cheater, finish({ survivalSec: 300 }));
    await service.finish(other, finish({ survivalSec: 400 }));

    expect(await service.setRanked(moderator, record.runId, false, "забег без урона за 8 минут")).toEqual({ accountId: cheater.accountId, ranked: false });
    expect(await board.best("normal", cheater.accountId)).toBe(300);
    expect(await board.rank("normal", cheater.accountId)).toBe(2);
    // Игрок видит у забега «не учтён после проверки».
    expect((await view.detail(cheater.accountId, record.runId)).rating).toBe("review");
    expect((await view.moderationRuns(cheater.accountId)).normal.map((run) => [run.survivalSec, run.ranked])).toEqual([
      [500, false],
      [300, true],
    ]);
    expect(rolesRepository.entries.at(-1)).toMatchObject({
      action: "players.run.unrank",
      target: cheater.accountId,
      after: { runId: record.runId, difficulty: "normal", survivalSec: 500, comment: "забег без урона за 8 минут" },
    });
    await expect(service.setRanked(moderator, record.runId, false, "ещё раз")).rejects.toMatchObject({ code: "run_ranking_conflict", status: 409 });

    await service.setRanked(moderator, record.runId, true, "ошиблись — запись забега чистая");
    expect(await board.best("normal", cheater.accountId)).toBe(500);
    expect(rolesRepository.entries.at(-1)).toMatchObject({ action: "players.run.rerank" });
    await expect(service.setRanked(moderator, record.runId, true, "ещё раз")).rejects.toMatchObject({ code: "run_ranking_conflict" });
  });

  it("единственный рекорд снят — игрок уходит из доски сложности; с закрытым рейтингом доску не трогаем, по сроку вернётся без снятого", async () => {
    const target = await player("Игрок");
    const only = finish({ survivalSec: 250 });
    await service.finish(target, only);
    await service.setRanked(moderator, only.runId, false, "накрутка");
    expect(await board.best("normal", target.accountId)).toBeNull();

    const best = finish({ survivalSec: 600 });
    const second = finish({ survivalSec: 200 });
    await service.finish(target, best);
    await service.finish(target, second);
    const [imposed] = await restrictions.impose(moderator, target.accountId, input());
    await service.setRanked(moderator, best.runId, false, "тот же приём");
    expect(await board.best("normal", target.accountId)).toBeNull();
    await restrictions.lift(moderator, imposed?.restrictionId ?? "", "разобрались");
    expect(await board.best("normal", target.accountId)).toBe(200);
  });

  it("право — модератора; чужой и незнакомый забег — 404; забег с читами или нечестный не возвращается", async () => {
    const target = await player("Игрок");
    const designer = await player("Геймдизайнер");
    await rolesRepository.grant(designer.accountId, "game_designer", null);
    const run = finish({ survivalSec: 250 });
    await service.finish(target, run);
    await expect(service.setRanked(designer, run.runId, false, "нельзя")).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.setRanked(moderator, "нет-такого-забега", false, "нет")).rejects.toMatchObject({ code: "run_not_found" });

    const cheats = finish({ survivalSec: 900, cheats: true });
    await service.finish(target, cheats);
    await expect(service.setRanked(moderator, cheats.runId, true, "вернуть")).rejects.toMatchObject({ code: "run_ranking_conflict" });
    expect((await view.moderationRuns(target.accountId)).normal.map((item) => item.runId)).toEqual([run.runId]);
  });
});

describe("забеги в рейтинге по HTTP", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("список по сложностям, снять и вернуть с причиной; без причины — 400, без права — 403, повтор — 409", async () => {
    const store = new MemoryAdminSessionStore();
    @Module({
      controllers: [AdminRunsController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: ROLES_REPOSITORY, useValue: rolesRepository },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: RunsService, useValue: service },
        { provide: RunsViewService, useValue: view },
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

    const target = await player("Игрок");
    const designer = await player("Геймдизайнер");
    await rolesRepository.grant(designer.accountId, "game_designer", null);
    await store.put(hashSessionToken("mod"), { ...moderator, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    await store.put(hashSessionToken("gd"), { ...designer, issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=mod`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
    const run = finish({ survivalSec: 420, difficultyId: "hard" });
    await service.finish(target, run);

    const list = await app.inject({ method: "GET", url: `/api/v1/admin/players/${target.accountId}/runs/rating`, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.runs).toMatchObject({ easy: [], normal: [], hard: [{ runId: run.runId, survivalSec: 420, ranked: true }] });
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/players/not-a-uuid/runs/rating", headers })).statusCode).toBe(400);

    const unrank = `/api/v1/admin/runs/${run.runId}/unrank`;
    expect((await app.inject({ method: "POST", url: unrank, headers, payload: { comment: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: unrank, headers: { ...headers, cookie: `${ADMIN_SESSION_COOKIE}=gd` }, payload: { comment: "нельзя" } })).statusCode).toBe(403);
    const done = await app.inject({ method: "POST", url: unrank, headers, payload: { comment: "рекорд без урона" } });
    expect(done.statusCode).toBe(201);
    expect(done.json().data).toEqual({ accountId: target.accountId, ranked: false });
    const again = await app.inject({ method: "POST", url: unrank, headers, payload: { comment: "ещё раз" } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("run_ranking_conflict");

    expect((await app.inject({ method: "POST", url: `/api/v1/admin/runs/${run.runId}/rerank`, headers, payload: { comment: "ошиблись" } })).statusCode).toBe(201);
    expect(await board.best("hard", target.accountId)).toBe(420);
  });
});
