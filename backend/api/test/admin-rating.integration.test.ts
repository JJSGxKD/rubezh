import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "../src/common/domain-error.js";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import type { Permission } from "../src/modules/roles/permissions.js";
import type { AccountRef, RolesService } from "../src/modules/roles/roles.service.js";
import { seasonOf } from "../src/modules/seasons/season-rules.js";
import { SeasonNotFoundError, SeasonsAdminService } from "../src/modules/seasons/seasons-admin.service.js";
import { PrismaSeasonsAdminRepository } from "../src/modules/seasons/seasons-admin.repository.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Архив сезонов в панели на живом Postgres (tasks/T-0380, Р189;
 * docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без него
 * пропуск). Память этого не покажет: соединение итогов с аккаунтом и наградой,
 * порядок по месту, счёт `total` и страницы — дело запроса.
 *
 * Сезоны берутся из далёкого будущего со случайной сдвижкой: база общая для
 * всех прогонов, и закрытый сезон чужого теста не должен попасть в страницу.
 * Три сезона идут подряд, поэтому между ними чужому сезону встать негде.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const live = DATABASE_URL !== "";

const WEEK = 7 * 86_400_000;
const ACTOR: AccountRef = { accountId: "00000000-0000-4000-8000-000000000001", platform: "telegram", platformUserId: "1" };

describe.skipIf(!live)("рейтинг в панели на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  const marker = `rt${Date.now().toString(36)}`;
  const keys: string[] = [];
  const created: string[] = [];

  // Первый из трёх сезонов: понедельник в 2045–2090 годах (настройка points-from не принимает дату позже 2099).
  const first = seasonOf(new Date(Date.UTC(2045, 0, 1) + randomInt(0, 2_400) * WEEK));
  const seasonAt = (index: number) => seasonOf(new Date(first.startsAt.getTime() + index * WEEK));
  const [s1, s2, s3] = [seasonAt(0), seasonAt(1), seasonAt(2)];

  const service = (granted: readonly Permission[] = ["players.view"]) => {
    const set = new Set<Permission>(granted);
    // Третий сезон идёт по очкам: переход — в его понедельник.
    const schedule = new SeasonSchedule(panelSettings({ "rating.points-from": Number(s3.key.replaceAll("-", "")) }));
    return new SeasonsAdminService(schedule, {} as never, {} as never, {} as never, {} as never, new PrismaSeasonsAdminRepository(prisma), { can: async (_actor: AccountRef, permission: Permission) => set.has(permission) } as unknown as RolesService);
  };
  const withFull = ["players.view", "players.board.restrict"] as const;

  async function account(name: string) {
    const row = await accounts.upsert({ platform: "telegram", platformUserId: String(930_000_000 + randomInt(0, 60_000_000)), displayName: `${name} ${marker}`, username: null, photoUrl: null }, Date.now());
    created.push(row.accountId);
    return row.accountId;
  }

  async function season(value: { key: string; startsAt: Date; endsAt: Date }, players: number, rewarded: number) {
    keys.push(value.key);
    await prisma.season.create({ data: { seasonKey: value.key, startsAt: value.startsAt, endsAt: value.endsAt, closedAt: new Date(value.endsAt.getTime() + 60_000), players, rewarded } });
  }

  const result = async (seasonKey: string, accountId: string, difficulty: "easy" | "normal" | "hard", place: number, boardSize: number, patch: { board?: string; division?: string | null; bestSec?: number } = {}) =>
    await prisma.seasonResult.create({ data: { seasonKey, accountId, difficulty, bestSec: patch.bestSec ?? 1000 - place, place, boardSize, board: patch.board ?? "common", division: patch.division === undefined ? "bronze" : patch.division } });

  let a = "";
  let b = "";
  let c = "";
  let d = "";
  const claimedAt = new Date("2200-01-01T10:00:00Z");

  beforeAll(async () => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    accounts = new PrismaAccountRepository(prisma);
    [a, b, c, d] = [await account("Альфа"), await account("Бета"), await account("Гамма"), await account("Дельта")];
    await season(s1, 4, 2);
    await season(s2, 1, 0);
    await season(s3, 1, 0);

    // Вставка не по порядку мест: порядок обязан дать запрос, а не вставка.
    await result(s1.key, c, "hard", 3, 3, { division: "bronze" });
    await result(s1.key, a, "hard", 1, 3, { division: "ruby", bestSec: 1500 });
    await result(s1.key, b, "hard", 2, 3, { division: "gold" });
    await result(s1.key, a, "easy", 1, 2, { division: "ruby" });
    await result(s1.key, b, "easy", 2, 2, { division: "bronze" });
    // Аккаунт отдельной доски: места и размер — своей доски.
    await result(s1.key, d, "hard", 1, 1, { board: "full", division: "ruby" });
    await prisma.seasonReward.create({ data: { seasonKey: s1.key, accountId: a, coins: 100, prestige: 5, difficulty: "hard", place: 1, kind: "place", status: "claimed", claimedAt } });
    await prisma.seasonReward.create({ data: { seasonKey: s1.key, accountId: b, coins: 20, prestige: 1, difficulty: null, place: null, kind: "threshold", status: "pending" } });
    await result(s2.key, a, "hard", 1, 1, { division: null });
    await result(s3.key, a, "hard", 1, 1, { bestSec: 4200 });
  });

  afterAll(async () => {
    await prisma.season.deleteMany({ where: { seasonKey: { in: keys } } });
    await prisma.account.deleteMany({ where: { accountId: { in: created } } });
    await prisma.$disconnect();
  });

  it("архив: limit=2 даёт два новых сезона и next, before=next — третий", async () => {
    const page = await service().seasons({ before: seasonAt(3).key, limit: 2 });
    expect(page.seasons.map((item) => item.key)).toEqual([s3.key, s2.key]);
    expect(page.next).toBe(s2.key);
    expect(page.seasons[0]).toMatchObject({ startsAt: s3.startsAt.toISOString(), endsAt: s3.endsAt.toISOString(), players: 1, rewarded: 0, scoring: "points" });
    expect(page.seasons[1]?.scoring).toBe("time");

    const older = await service().seasons({ before: page.next ?? "", limit: 2 });
    expect(older.seasons[0]).toMatchObject({ key: s1.key, players: 4, rewarded: 2, scoring: "time" });
    expect(older.seasons[0]?.closedAt).toBe(new Date(s1.endsAt.getTime() + 60_000).toISOString());
  });

  it("архив: три сезона подряд идут по убыванию ключа", async () => {
    const page = await service().seasons({ before: seasonAt(3).key, limit: 52 });
    expect(page.seasons.slice(0, 3).map((item) => item.key)).toEqual([s3.key, s2.key, s1.key]);
    expect(page.seasons.length).toBeLessThanOrEqual(52);
  });

  it("итоги сезона по сложности: порядок по месту, total, имя из аккаунта", async () => {
    const view = await service().season(ACTOR, s1.key, { difficulty: "hard", board: "common", offset: 0, limit: 100 });
    expect(view.season.key).toBe(s1.key);
    expect(view.total).toBe(3);
    expect(view.rows.map((row) => [row.place, row.accountId, row.name, row.boardSize])).toEqual([
      [1, a, `Альфа ${marker}`, 3],
      [2, b, `Бета ${marker}`, 3],
      [3, c, `Гамма ${marker}`, 3],
    ]);
    expect(view.rows.map((row) => row.division)).toEqual(["ruby", "gold", "bronze"]);
    expect(view.rows[0]?.best).toBe(1500);

    const page = await service().season(ACTOR, s1.key, { difficulty: "hard", board: "common", offset: 1, limit: 1 });
    expect(page.total).toBe(3);
    expect(page.rows.map((row) => row.accountId)).toEqual([b]);
  });

  it("награда за место — только в строке своей сложности, за порог — в каждой строке аккаунта; status и claimedAt как в базе", async () => {
    const hard = await service().season(ACTOR, s1.key, { difficulty: "hard", board: "common", offset: 0, limit: 100 });
    const easy = await service().season(ACTOR, s1.key, { difficulty: "easy", board: "common", offset: 0, limit: 100 });
    const reward = (view: typeof hard, accountId: string) => view.rows.find((row) => row.accountId === accountId)?.reward;

    expect(reward(hard, a)).toEqual({ kind: "place", coins: 100, prestige: 5, status: "claimed", claimedAt: claimedAt.toISOString() });
    expect(reward(easy, a)).toBeNull();
    expect(reward(hard, b)).toEqual({ kind: "threshold", coins: 20, prestige: 1, status: "pending", claimedAt: null });
    expect(reward(easy, b)).toEqual({ kind: "threshold", coins: 20, prestige: 1, status: "pending", claimedAt: null });
    expect(reward(hard, c)).toBeNull();
  });

  it("строки board = 'full' без players.board.restrict не отдаются; с правом board=full читает их", async () => {
    await expect(service().season(ACTOR, s1.key, { difficulty: "hard", board: "full", offset: 0, limit: 100 })).rejects.toBeInstanceOf(ForbiddenError);

    const common = await service(withFull).season(ACTOR, s1.key, { difficulty: "hard", board: "common", offset: 0, limit: 100 });
    expect(common.rows.map((row) => row.accountId)).not.toContain(d);
    expect(common.total).toBe(3);

    const full = await service(withFull).season(ACTOR, s1.key, { difficulty: "hard", board: "full", offset: 0, limit: 100 });
    expect(full).toMatchObject({ board: "full", total: 1 });
    expect(full.rows.map((row) => [row.accountId, row.place, row.boardSize])).toEqual([[d, 1, 1]]);
  });

  it("места игрока: сезоны по убыванию ключа, scoring по rating.points-from, награда в сезоне", async () => {
    const view = await service().playerSeasons(ACTOR, a);
    expect(view.seasons.map((item) => item.key)).toEqual([s3.key, s2.key, s1.key]);
    expect(view.seasons.map((item) => item.scoring)).toEqual(["points", "time", "time"]);
    expect(view.seasons[0]).toMatchObject({ startsAt: s3.startsAt.toISOString(), reward: null, results: [{ difficulty: "hard", best: 4200, place: 1, boardSize: 1 }] });
    expect(view.seasons[1]?.results[0]?.division).toBeNull();
    const oldest = view.seasons[2];
    expect(oldest?.results.map((row) => row.difficulty).sort()).toEqual(["easy", "hard"]);
    expect(oldest?.reward).toEqual({ kind: "place", coins: 100, prestige: 5, status: "claimed", claimedAt: claimedAt.toISOString(), difficulty: "hard", place: 1 });
    // Без права поля `board` в строках нет.
    expect(oldest?.results.every((row) => !("board" in row))).toBe(true);
  });

  it("места игрока на отдельной доске: без права сезона нет, с правом — строка с полем board", async () => {
    expect((await service().playerSeasons(ACTOR, d)).seasons).toEqual([]);
    const view = await service(withFull).playerSeasons(ACTOR, d);
    expect(view.seasons.map((item) => item.key)).toEqual([s1.key]);
    expect(view.seasons[0]?.results).toEqual([{ difficulty: "hard", best: 999, place: 1, boardSize: 1, division: "ruby", board: "full" }]);

    const own = await service(withFull).playerSeasons(ACTOR, a);
    expect(own.seasons[2]?.results.every((row) => row.board === "common")).toBe(true);
  });

  it("аккаунт без итогов — пустой список", async () => {
    expect(await service().playerSeasons(ACTOR, "00000000-0000-4000-8000-0000000000ff")).toEqual({ seasons: [] });
  });

  it("несуществующий сезон — 404 «Сезон не найден»", async () => {
    await expect(service().season(ACTOR, seasonAt(5).key, { difficulty: "hard", board: "common", offset: 0, limit: 100 })).rejects.toBeInstanceOf(SeasonNotFoundError);
  });
});
