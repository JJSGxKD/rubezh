import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaPlayerListRepository, levelSegmentSql, timeOrderedSql, type PlayerListRow, type PlayerPage } from "../src/modules/player-list/player-list.repository.js";
import type { PlayerFilters, PlayerSort } from "../src/modules/player-list/player-list-query.js";

/**
 * Список игроков на живом Postgres (docs/35-stage4-plan.md WP32; адрес —
 * TEST_DATABASE_URL, без него пропуск): фильтры по соседним таблицам,
 * страницы по курсору без потерь и повторов, уровень двумя отрезками и план
 * запроса — по индексу, а не сортировкой всей таблицы (критерий приёмки).
 *
 * Аккаунты — на площадке `max` и с регистрацией в своём окне времени: база
 * общая и между прогонами, а фильтр окна отрезает чужих.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const MINUTE = 60_000;

describe.skipIf(DATABASE_URL === "")("список игроков на живом Postgres", () => {
  let prisma: PrismaClient;
  let repository: PrismaPlayerListRepository;
  const base = Date.UTC(2001, 0, 1) + Math.floor(Math.random() * 300) * 86_400_000;
  const window: PlayerFilters = { platform: "max", registeredFrom: new Date(base), registeredTo: new Date(base + 86_400_000) };
  /** id по порядку регистрации: 0 — самый ранний */
  const ids: string[] = [];

  async function all(sort: PlayerSort, order: "asc" | "desc", filters: PlayerFilters = window, pageSize = 2): Promise<PlayerListRow[]> {
    const rows: PlayerListRow[] = [];
    let cursor: PlayerPage["cursor"] = null;
    for (let guard = 0; guard < 50; guard++) {
      const page = await repository.page({ filters, sort, order, cursor, limit: pageSize + 1 });
      rows.push(...page.slice(0, pageSize));
      const last = page[pageSize - 1];
      if (page.length <= pageSize || last === undefined) return rows;
      cursor = { sort, value: sort === "registered" ? last.createdAt.getTime() : sort === "seen" ? last.lastSeenAt.getTime() : last.level, accountId: last.accountId };
    }
    throw new Error("страницы не кончились");
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    repository = new PrismaPlayerListRepository(prisma);
    const accounts = new PrismaAccountRepository(prisma);
    // Шесть игроков; у двух — одинаковое время регистрации: курсор обязан различать их по id.
    const minutes = [0, 1, 2, 2, 3, 4];
    for (const [index, minute] of minutes.entries()) {
      const account = await accounts.upsert({ platform: "max", platformUserId: `pl-${String(base)}-${String(index)}`, displayName: `Игрок ${String(index)}`, username: null }, base + minute * MINUTE);
      ids.push(account.accountId);
    }
    const at = new Date(base);
    // Уровни: 5, 3, 3 у троих, у остальных строки прогресса нет или первый уровень.
    await prisma.accountProgress.createMany({
      data: [
        { accountId: ids[1] ?? "", level: 5, xp: 900n, updatedAt: at },
        { accountId: ids[3] ?? "", level: 3, xp: 300n, updatedAt: at },
        { accountId: ids[4] ?? "", level: 3, xp: 310n, updatedAt: at },
        { accountId: ids[5] ?? "", level: 1, xp: 5n, updatedAt: at },
      ],
    });
    await prisma.acquisition.createMany({
      data: [0, 1, 2].map((index) => ({ accountId: ids[index] ?? "", firstAt: at, firstStartKind: index === 0 ? ("invite" as const) : ("organic" as const), firstDeviceClass: "unknown" as const, lastSeenAt: at })),
    });
    await prisma.accountFunnel.create({ data: { accountId: ids[2] ?? "", firstPurchaseAt: at } });
    await prisma.accountMessaging.createMany({ data: [{ accountId: ids[0] ?? "", canMessage: true, reason: "entered", changedAt: at }, { accountId: ids[1] ?? "", canMessage: false, reason: "blocked", changedAt: at }] });
    await accounts.setBan(ids[4] ?? "", { at, reason: "тест" });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("регистрация по убыванию и возрастанию: страницы по курсору без потерь и повторов, одинаковое время различает id", async () => {
    const desc = await all("registered", "desc");
    expect(desc).toHaveLength(6);
    expect(new Set(desc.map((row) => row.accountId)).size).toBe(6);
    expect(desc[0]?.accountId).toBe(ids[5]);
    expect(desc.at(-1)?.accountId).toBe(ids[0]);
    const asc = await all("registered", "asc");
    expect(asc.map((row) => row.accountId)).toEqual([...desc.map((row) => row.accountId)].reverse());
    expect((await all("seen", "desc")).map((row) => row.accountId)).toEqual(desc.map((row) => row.accountId));
  });

  it("уровень — прокачанные по индексу уровня, затем первый уровень, и обратно", async () => {
    const desc = await all("level", "desc");
    expect(desc.map((row) => row.level)).toEqual([5, 3, 3, 1, 1, 1]);
    expect(desc[0]?.accountId).toBe(ids[1]);
    expect(new Set(desc.map((row) => row.accountId)).size).toBe(6);
    const asc = await all("level", "asc");
    expect(asc.map((row) => row.level)).toEqual([1, 1, 1, 3, 3, 5]);
    expect(await all("level", "desc", { ...window, levelMin: 3 })).toHaveLength(3);
    expect((await all("level", "asc", { ...window, levelMax: 1 })).map((row) => row.level)).toEqual([1, 1, 1]);
    expect((await all("registered", "desc", { ...window, levelMin: 2, levelMax: 4 })).map((row) => row.level)).toEqual([3, 3]);
  });

  it("фильтры по соседним таблицам: источник, платящий, можно писать, блокировка", async () => {
    // Порядок здесь не проверяется: у двоих одинаковое время регистрации, и между ними решает id.
    const only = async (filters: Partial<PlayerFilters>) => (await all("registered", "asc", { ...window, ...filters })).map((row) => ids.indexOf(row.accountId)).sort();
    expect(await only({ source: "invite" })).toEqual([0]);
    expect(await only({ payer: true })).toEqual([2]);
    expect(await only({ payer: false })).toEqual([0, 1, 3, 4, 5]);
    expect(await only({ canMessage: true })).toEqual([0]);
    expect(await only({ canMessage: false })).toEqual([1, 2, 3, 4, 5]);
    expect(await only({ banned: true })).toEqual([4]);
    const [row] = await all("registered", "asc", { ...window, source: "invite" });
    expect(row).toMatchObject({ source: "invite", canMessage: true, payer: false, level: 1, campaign: null });
  });

  it("план: страница — отрезок индекса, без сортировки всей выборки", async () => {
    const page = (sort: PlayerSort): PlayerPage => ({ filters: { platform: "max" }, sort, order: "desc", cursor: { sort, value: sort === "level" ? 3 : base, accountId: ids[0] ?? "" }, limit: 51 });
    const plan = async (sql: Prisma.Sql): Promise<string> =>
      await prisma.$transaction(async (tx) => {
        // На маленькой тестовой таблице планировщику дешевле прочитать её целиком — запрет показывает, есть ли путь по индексу.
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        const rows = await tx.$queryRaw<{ "QUERY PLAN": string }[]>(Prisma.sql`EXPLAIN ${sql}`);
        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      });
    // Порядок страницы даёт сам индекс: он в плане, а между LIMIT и выборкой
    // нет сортировки — страница не читает таблицу целиком ради порядка.
    const ordered = (text: string, index: string): void => {
      expect(text).toContain(index);
      expect(text.split("\n")[1] ?? "").not.toMatch(/Sort/);
    };
    ordered(await plan(timeOrderedSql(page("registered"))), "account_created_at_account_id_idx");
    ordered(await plan(timeOrderedSql(page("seen"))), "account_last_seen_at_account_id_idx");
    // Уровень — без фильтра площадки: с ним на тестовой базе, где аккаунтов `max`
    // единицы, планировщику честно дешевле взять их по индексу площадки и
    // отсортировать горстку строк.
    const levelled = await plan(levelSegmentSql({ ...page("level"), filters: {} }, "levelled", 51));
    ordered(levelled, "account_progress_level_account_id_idx");
    expect(levelled).not.toMatch(/Sort Key: p\.level/);
    ordered(await plan(levelSegmentSql({ ...page("level"), filters: {}, cursor: null }, "first", 51)), "Index Scan Backward using account_pkey on account a");
  });
});
