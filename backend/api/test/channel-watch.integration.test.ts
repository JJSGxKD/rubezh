import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { RestrictionsHooks } from "../src/modules/restrictions/restrictions-hooks.js";
import { PrismaRestrictionsRepository } from "../src/modules/restrictions/restrictions.repository.js";
import { RestrictionsService } from "../src/modules/restrictions/restrictions.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { watchUntil } from "../src/modules/tasks/channel-watch-rules.js";
import { PrismaChannelWatchRepository } from "../src/modules/tasks/channel-watch.repository.js";
import { ChannelWatchService } from "../src/modules/tasks/channel-watch.service.js";
import { NO_ACHIEVEMENT_FIELDS, type TaskDef } from "../src/modules/tasks/task-rules.js";
import { PrismaTasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { ChannelMemberships, type ChannelMembership } from "../src/platforms/ports/channel-membership.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import type { WalletResource } from "../src/modules/wallet/wallet-types.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Окна перепроверки подписки на живом Postgres (docs/17-testing-strategy.md
 * §4.2; адрес — TEST_DATABASE_URL, без него пропуск): таблица и её ограничения,
 * выборка окон к проверке, полный круг с настоящим кошельком, лентой и
 * ограничениями, и гонка двух проходов по одной паре (docs/35-stage4-plan.md
 * Р115, tasks/T-0178).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** понедельник, 05.10.2026, 12:00 по Москве */
const MON = new Date(Date.UTC(2026, 9, 5, 9));
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const RACE_TIMEOUT_MS = 30_000;

/** Бот площадки: состоят все, кого не отписали. */
class FakeMembership implements ChannelMembership {
  readonly platform = "telegram" as const;
  readonly left = new Set<string>();
  async isMember(_chat: string, platformUserId: string): Promise<boolean> {
    await Promise.resolve();
    return !this.left.has(platformUserId);
  }
}

describe.skipIf(DATABASE_URL === "")("окна перепроверки подписки на живом Postgres", () => {
  const suffix = randomUUID().slice(0, 8);
  const TASK = `it_sub_${suffix}`;
  const TASK_B = `it_sub_b_${suffix}`;
  const CHAT = `@rubezh_it_${suffix}`;

  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let watch: PrismaChannelWatchRepository;
  let wallet: WalletService;
  let service: ChannelWatchService;
  let membership: FakeMembership;
  let tasks: PrismaTasksRepository;

  function def(taskId: string): TaskDef {
    return {
      taskId,
      period: "daily",
      kind: "channel",
      params: { platform: "telegram", chat: CHAT, url: "https://t.me/rubezh_it" },
      filter: null,
      tier: null,
      target: 1,
      title: "Канал для проверки",
      coins: 100,
      gems: 5,
      shards: 0,
      passPoints: 0,
      sort: 0,
      active: true,
      limit: null,
      image: null,
      ...NO_ACHIEVEMENT_FIELDS,
    };
  }

  async function player(): Promise<AccountRef> {
    const platformUserId = String(940_000_000 + Math.floor(Math.random() * 50_000_000));
    const created = await accounts.upsert({ platform: "telegram", platformUserId, displayName: "Подписчик", username: null }, Date.now());
    return { accountId: created.accountId, platform: "telegram", platformUserId };
  }

  const key = (accountId: string, taskId: string, periodStart: string) => ({ accountId, taskId, periodStart });

  /** Награда за подписку так, как её выдаёт забор: кошельком по ключу задания и срока, потом окно. */
  async function reward(account: AccountRef, taskId: string, periodStart: string, when: Date): Promise<void> {
    for (const [resource, amount] of [["coins", 100], ["gems", 5]] as const) {
      await wallet.grant({ accountId: account.accountId, resource, amount, reason: "task_reward", source: `task:${taskId}`, idempotencyKey: `task:${account.accountId}:${taskId}:${periodStart}:${resource}`, at: when });
    }
    expect(await service.start(account, def(taskId), periodStart, when)).toBe(true);
  }

  const balance = async (accountId: string, resource: WalletResource) => (await wallet.balances(accountId))[resource];
  const windowRows = (accountId: string) =>
    prisma.$queryRaw<{ task_id: string; period_start: string; state: string; event_no: number | null; revoked: unknown }[]>`
      SELECT task_id, period_start::text AS period_start, state, event_no, revoked FROM task_channel_watch WHERE account_id = ${accountId}::uuid ORDER BY period_start`;
  /** Сколько строк списания `task_revoke` в журнале кошелька игрока. */
  const revokeEntries = async (accountId: string) => {
    const [row] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM wallet_entry WHERE account_id = ${accountId}::uuid AND reason = 'task_revoke'`;
    return Number(row?.n ?? 0n);
  };

  beforeAll(async () => {
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 20);
    accounts = new PrismaAccountRepository(prisma);
    watch = new PrismaChannelWatchRepository(prisma);
    tasks = new PrismaTasksRepository(prisma);
    const roles = new RolesService(config, new MemoryRolesRepository(), accounts);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, roles);
    const restrictionRows = new PrismaRestrictionsRepository(prisma);
    const restrictions = new RestrictionsService(restrictionRows, accounts, roles, restrictionsGate(restrictionRows), new RestrictionsHooks());
    membership = new FakeMembership();
    service = new ChannelWatchService(watch, tasks, accounts, new ChannelMemberships([membership]), wallet, restrictions, new NotificationsService(new PrismaNotificationsRepository(prisma)));
    const author = await player();
    for (const taskId of [TASK, TASK_B]) await tasks.insert(def(taskId), author.accountId, MON);
  });

  beforeEach(async () => {
    // Таблицу окон пишет только этот файл: чистая, чтобы проход не подхватил чужие окна.
    await prisma.$executeRaw`DELETE FROM task_channel_watch`;
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM task_channel_watch`;
    await prisma.$disconnect();
  });

  it("миграция создаёт таблицу; `start` на повторе возвращает `false`; удаление аккаунта удаляет его окна", async () => {
    const [exists] = await prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('task_channel_watch') IS NOT NULL AS present`;
    expect(exists?.present).toBe(true);

    const account = await player();
    const row = { ...key(account.accountId, TASK, "2026-10-05"), startedAt: MON, watchUntil: watchUntil(MON), nextCheckAt: at(MON, 6 * HOUR) };
    expect(await watch.start(row)).toBe(true);
    expect(await watch.start({ ...row, startedAt: at(MON, HOUR) })).toBe(false);
    expect(await windowRows(account.accountId)).toEqual([{ task_id: TASK, period_start: "2026-10-05", state: "watching", event_no: null, revoked: null }]);

    await prisma.account.delete({ where: { accountId: account.accountId } });
    expect(await windowRows(account.accountId)).toEqual([]);
  });

  it("база не примет неизвестное состояние и окно на несуществующее задание", async () => {
    const account = await player();
    await watch.start({ ...key(account.accountId, TASK, "2026-10-05"), startedAt: MON, watchUntil: watchUntil(MON), nextCheckAt: at(MON, 6 * HOUR) });

    await expect(prisma.$executeRaw`UPDATE task_channel_watch SET state = 'bogus' WHERE account_id = ${account.accountId}::uuid`).rejects.toThrow();
    await expect(watch.start({ ...key(account.accountId, `no_such_${suffix}`, "2026-10-05"), startedAt: MON, watchUntil: watchUntil(MON), nextCheckAt: at(MON, 6 * HOUR) })).rejects.toThrow();
  });

  it("`due` отдаёт только `watching` с наступившим сроком, по возрастанию срока; закрытые окна не отдаёт", async () => {
    const accountsList = [await player(), await player(), await player(), await player(), await player()];
    const [late, early, kept, expired, penalized] = accountsList;
    if (late === undefined || early === undefined || kept === undefined || expired === undefined || penalized === undefined) throw new Error("нет аккаунтов");
    const open = (account: AccountRef, minutes: number) =>
      watch.start({ ...key(account.accountId, TASK, "2026-10-05"), startedAt: MON, watchUntil: watchUntil(MON), nextCheckAt: at(MON, minutes * 60_000) });
    await open(late, 30);
    await open(early, 10);
    await open(kept, 5);
    await open(expired, 6);
    await open(penalized, 7);
    // не наступил: срок позже «сейчас»
    const future = await player();
    await open(future, 600);
    await watch.close([key(kept.accountId, TASK, "2026-10-05")], "kept", at(MON, 20 * 60_000));
    await watch.close([key(expired.accountId, TASK, "2026-10-05")], "expired", at(MON, 20 * 60_000));
    await watch.markPenalized([{ key: key(penalized.accountId, TASK, "2026-10-05"), revoked: { coins: 1, gems: 0, shards: 0 } }], 1, at(MON, 20 * 60_000));

    const due = await watch.due(at(MON, 60 * 60_000), 100);

    expect(due.map((row) => row.accountId)).toEqual([early.accountId, late.accountId]);
    expect(due[0]).toMatchObject({ taskId: TASK, periodStart: "2026-10-05", state: "watching", checkedAt: null, eventNo: null, startedAt: MON });
    expect(await watch.due(at(MON, 60 * 60_000), 1)).toHaveLength(1);
  });

  it("`postpone`, `close` и `markPenalized` пишут только окна в `watching`: закрытое второй раз не меняется", async () => {
    const account = await player();
    const k = key(account.accountId, TASK, "2026-10-05");
    await watch.start({ ...k, startedAt: MON, watchUntil: watchUntil(MON), nextCheckAt: at(MON, 6 * HOUR) });

    await watch.postpone([k], at(MON, 12 * HOUR), at(MON, 6 * HOUR));
    expect((await watch.openOf(account.accountId, TASK))[0]).toMatchObject({ nextCheckAt: at(MON, 12 * HOUR), checkedAt: at(MON, 6 * HOUR) });
    await watch.postpone([k], at(MON, 18 * HOUR), null);
    expect((await watch.openOf(account.accountId, TASK))[0]).toMatchObject({ nextCheckAt: at(MON, 18 * HOUR), checkedAt: at(MON, 6 * HOUR) });

    await watch.markPenalized([{ key: k, revoked: { coins: 100, gems: 5, shards: 0 } }], 1, at(MON, 20 * HOUR));
    await watch.close([k], "kept", at(MON, 21 * HOUR));
    await watch.markPenalized([{ key: k, revoked: { coins: 0, gems: 0, shards: 0 } }], 2, at(MON, 22 * HOUR));

    expect(await windowRows(account.accountId)).toEqual([{ task_id: TASK, period_start: "2026-10-05", state: "penalized", event_no: 1, revoked: { coins: 100, gems: 5, shards: 0 } }]);
    expect(await watch.openOf(account.accountId, TASK)).toEqual([]);
    expect(await watch.lastEventNo(account.accountId, TASK)).toBe(1);
    expect(await watch.lastEventNo(account.accountId, TASK_B)).toBe(0);
  });

  it("полный круг с настоящим кошельком: списание ключом награды, баланс не ниже нуля, окно `penalized`; второй проход ничего не списывает", async () => {
    const account = await player();
    await reward(account, TASK, "2026-10-05", MON);
    // игрок потратил 30 монет из 100
    await wallet.spend({ accountId: account.accountId, lines: [{ resource: "coins", amount: 30 }], reason: "shop", idempotencyKey: `it-spend:${randomUUID()}` });
    membership.left.add(account.platformUserId);

    await service.tick(at(MON, 2 * DAY));

    expect(await balance(account.accountId, "coins")).toBe(0);
    expect(await balance(account.accountId, "gems")).toBe(0);
    const ledger = await prisma.$queryRaw<{ resource: string; amount: bigint; source: string | null; idempotency_key: string }[]>`
      SELECT resource::text AS resource, amount, source, idempotency_key FROM wallet_entry
      WHERE account_id = ${account.accountId}::uuid AND reason = 'task_revoke' ORDER BY resource`;
    expect(ledger.map((entry) => [entry.resource, Number(entry.amount), entry.source, entry.idempotency_key])).toEqual([
      ["coins", -70, `task:${TASK}`, `taskrevoke:${account.accountId}:${TASK}:2026-10-05:coins`],
      ["gems", -5, `task:${TASK}`, `taskrevoke:${account.accountId}:${TASK}:2026-10-05:gems`],
    ]);
    expect(await windowRows(account.accountId)).toEqual([{ task_id: TASK, period_start: "2026-10-05", state: "penalized", event_no: 1, revoked: { coins: 70, gems: 5, shards: 0 } }]);
    const feed = await prisma.notification.findMany({ where: { accountId: account.accountId, kind: "task_unsubscribed" }, select: { payload: true, dedupeKey: true } });
    expect(feed).toEqual([{ payload: { title: "Канал для проверки", coins: 70, gems: 5, shards: 0, closedUntil: null }, dedupeKey: `task_unsubscribed:${account.accountId}:${TASK}:1` }]);
    expect(await prisma.accountRestriction.count({ where: { accountId: account.accountId } })).toBe(0);

    // второй проход: окно закрыто, у игрока снова есть деньги — их не трогают
    await wallet.grant({ accountId: account.accountId, resource: "coins", amount: 50, reason: "run_reward", idempotencyKey: `it-income:${randomUUID()}` });
    await service.tick(at(MON, 3 * DAY));
    expect(await balance(account.accountId, "coins")).toBe(50);
    expect(await revokeEntries(account.accountId)).toBe(2);
  }, RACE_TIMEOUT_MS);

  it("баланс 0 не уходит в минус: окно оштрафовано, строк списания нет", async () => {
    const account = await player();
    await reward(account, TASK, "2026-10-05", MON);
    await wallet.spend({ accountId: account.accountId, lines: [{ resource: "coins", amount: 100 }, { resource: "gems", amount: 5 }], reason: "shop", idempotencyKey: `it-spend:${randomUUID()}` });
    membership.left.add(account.platformUserId);

    await service.tick(at(MON, DAY));

    expect(await balance(account.accountId, "coins")).toBe(0);
    expect(await balance(account.accountId, "gems")).toBe(0);
    expect(await revokeEntries(account.accountId)).toBe(0);
    expect(await windowRows(account.accountId)).toEqual([{ task_id: TASK, period_start: "2026-10-05", state: "penalized", event_no: 1, revoked: { coins: 0, gems: 0, shards: 0 } }]);
  }, RACE_TIMEOUT_MS);

  it("повтор в том же задании закрывает `partner_tasks` на 30 суток, причина `task_unsubscribe`", async () => {
    const account = await player();
    await reward(account, TASK, "2026-10-05", MON);
    membership.left.add(account.platformUserId);
    await service.tick(at(MON, DAY));
    membership.left.delete(account.platformUserId);
    await reward(account, TASK, "2026-10-09", at(MON, 4 * DAY));
    membership.left.add(account.platformUserId);
    const saturday = at(MON, 5 * DAY);

    await service.tick(saturday);

    const rows = await prisma.accountRestriction.findMany({ where: { accountId: account.accountId }, select: { kind: true, reason: true, startsAt: true, endsAt: true, imposedBy: true } });
    expect(rows).toEqual([{ kind: "partner_tasks", reason: "task_unsubscribe", startsAt: saturday, endsAt: at(saturday, 30 * DAY), imposedBy: null }]);
    const feed = await prisma.notification.findMany({ where: { accountId: account.accountId, kind: "task_unsubscribed" }, select: { dedupeKey: true, payload: true }, orderBy: { dedupeKey: "asc" } });
    expect(feed.map((note) => note.dedupeKey)).toEqual([`task_unsubscribed:${account.accountId}:${TASK}:1`, `task_unsubscribed:${account.accountId}:${TASK}:2`]);
    expect(feed[1]?.payload).toMatchObject({ closedUntil: at(saturday, 30 * DAY).toISOString() });
  }, RACE_TIMEOUT_MS);

  it("два одновременных прохода по одной паре: списание, уведомление и ограничение — по одному", async () => {
    const account = await player();
    await reward(account, TASK, "2026-10-05", MON);
    membership.left.add(account.platformUserId);
    await service.tick(at(MON, DAY));
    membership.left.delete(account.platformUserId);
    await reward(account, TASK, "2026-10-09", at(MON, 4 * DAY));
    membership.left.add(account.platformUserId);
    const now = at(MON, 5 * DAY);

    await Promise.all([service.tick(now), service.tick(now)]);

    expect(await windowRows(account.accountId)).toEqual([
      { task_id: TASK, period_start: "2026-10-05", state: "penalized", event_no: 1, revoked: { coins: 100, gems: 5, shards: 0 } },
      { task_id: TASK, period_start: "2026-10-09", state: "penalized", event_no: 2, revoked: { coins: 100, gems: 5, shards: 0 } },
    ]);
    expect(await revokeEntries(account.accountId)).toBe(4);
    expect(await prisma.notification.count({ where: { accountId: account.accountId, kind: "task_unsubscribed" } })).toBe(2);
    expect(await prisma.accountRestriction.count({ where: { accountId: account.accountId, reason: "task_unsubscribe" } })).toBe(1);
  }, RACE_TIMEOUT_MS);

  it("замок пары не пускает второго, пока первый работает, и отпускается после; разные пары не мешают друг другу", async () => {
    const account = await player();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const first = watch.withPairLock(account.accountId, TASK, async () => {
      entered();
      await gate;
      return "первый";
    });
    await inside;
    expect(await watch.withPairLock(account.accountId, TASK, async () => "второй")).toEqual({ locked: false });
    expect(await watch.withPairLock(account.accountId, TASK_B, async () => "другая пара")).toEqual({ locked: true, value: "другая пара" });

    release();
    expect(await first).toEqual({ locked: true, value: "первый" });
    expect(await watch.withPairLock(account.accountId, TASK, async () => "после")).toEqual({ locked: true, value: "после" });
  });
});
