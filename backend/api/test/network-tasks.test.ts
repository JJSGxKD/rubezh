import "reflect-metadata";
import { Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { AdTaskHooks, AdTasks, TASK_SESSION_TTL_MIN, sameSecret } from "../src/modules/ads/ad-tasks.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { AdsgramRewardController } from "../src/modules/ads/adsgram-reward.controller.js";
import { AdsService } from "../src/modules/ads/ads.service.js";
import type { PlaceHistory } from "../src/modules/ads/ads.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { ADSGRAM_REWARD_PATH, SECRETS, type SecretDefinition } from "../src/modules/secrets/secret-catalog.js";
import { SECRETS_READER, type SecretsReader } from "../src/modules/secrets/secrets.service.js";
import { admitsTask, networkTaskSchema, networkTaskState, nextTaskAt, type NetworkTaskDef } from "../src/modules/tasks/network-task-rules.js";
import type { NetworkTaskRow, NetworkTasksRepository } from "../src/modules/tasks/network-tasks.repository.js";
import { NetworkTasksService } from "../src/modules/tasks/network-tasks.service.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { FakeCreatives, MemoryAds, adBlock, interstitialGate, moscowDayStart } from "./helpers/memory-ads.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Задания рекламных сетей во вкладке «Партнёры» (docs/35-stage4-plan.md
 * WP13, часть 6): задание AdsGram не появляется чаще потолка и раньше
 * паузы, считая по московским суткам; награду даёт только подтверждение
 * сети с верным секретом и только за выданное задание; повтор
 * подтверждения не награждает дважды, а сорвавшаяся выдача дожимается.
 */

const MINUTE = 60_000;
/** 03.10.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 9, 3, 9));
const at = (minutes: number) => new Date(NOON.getTime() + minutes * MINUTE);
const SECRET = "aBcD3fGh1jKlMn0pQrStUvWxYz_-aBcD3fGh1jKlMnO";
const TG_ID = "4242";
const OWNER_ID = "777000333";

const ROW: NetworkTaskRow = { networkKey: "adsgram", active: true, dailyCap: 2, pauseMin: 30, coins: 100, gems: 0, shards: 2, updatedAt: NOON, updatedBy: null };

class MemoryNetworkTasks implements NetworkTasksRepository {
  constructor(readonly rows: NetworkTaskRow[]) {}

  async all(): Promise<NetworkTaskRow[]> {
    return this.rows.map((row) => ({ ...row }));
  }

  async update(def: NetworkTaskDef, actorAccountId: string, time: Date): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.networkKey === def.networkKey);
    if (index < 0) return false;
    this.rows[index] = { ...def, updatedAt: time, updatedBy: actorAccountId };
    return true;
  }
}

class FakeWallet {
  readonly grants: GrantInput[] = [];
  private readonly keys = new Set<string>();
  failNext = false;

  async grant(input: GrantInput): Promise<GrantResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("кошелёк недоступен");
    }
    const duplicate = this.keys.has(input.idempotencyKey);
    if (!duplicate) {
      this.keys.add(input.idempotencyKey);
      this.grants.push(input);
    }
    return { credited: input.amount, balance: 0, duplicate };
  }
}

/** Ключи интеграций в памяти: адрес награды создан или нет. */
function secretsOf(value: string | null): SecretsReader & { value: string | null } {
  return {
    value,
    get(secret: SecretDefinition) {
      return secret.key === SECRETS.adsgramRewardSecret.key ? this.value : null;
    },
  };
}

async function setup(options: { secret?: string | null; blocks?: ReturnType<typeof adBlock>[]; rows?: NetworkTaskRow[] } = {}) {
  const adsRepository = new MemoryAds();
  adsRepository.blocks = options.blocks ?? [adBlock("adsgram", 10, { place: "task" })];
  const settings = panelSettings();
  const passes = new AdPasses();
  const ads = new AdsService(adsRepository, () => 0, passes, settings, new FakeCreatives(), new AdNetworkKeys(adsRepository), interstitialGate(adsRepository, settings));
  const secrets = secretsOf(options.secret === undefined ? SECRET : options.secret);
  const accounts = new MemoryAccountRepository();
  const hooks = new AdTaskHooks();
  const adTasks = new AdTasks(adsRepository, ads, settings, secrets, accounts, hooks);
  const rows = new MemoryNetworkTasks((options.rows ?? [ROW]).map((row) => ({ ...row })));
  const wallet = new FakeWallet();
  const rolesRepository = new MemoryRolesRepository();
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
  const service = new NetworkTasksService(rows, adTasks, hooks, ads, wallet as unknown as WalletService, new RolesService(config, rolesRepository, accounts));
  service.onModuleInit();
  const ref = async (id: string, platform: "telegram" | "vk" = "telegram"): Promise<AccountRef> => {
    const account = await accounts.upsert({ platform, platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, NOON.getTime());
    return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
  };
  const player = await ref(TG_ID);
  return { adsRepository, ads, passes, adTasks, secrets, rows, wallet, rolesRepository, service, player, ref };
}

/** История места `task` из выполненных в эти минуты от полудня. */
function history(doneAt: number[], networkKey = "adsgram"): PlaceHistory {
  return {
    dayStart: moscowDayStart(NOON),
    sessions: doneAt.map((minutes, index) => ({
      sessionId: `s${String(index)}`,
      accountId: "a",
      place: "task",
      networkKey,
      success: "cpa",
      status: "claimed",
      createdAt: at(minutes - 5),
      shownAt: at(minutes - 5),
      completedAt: at(minutes),
      claimedAt: at(minutes),
    })),
  };
}

describe("потолок и пауза строки сети", () => {
  const def = { dailyCap: 2, pauseMin: 30 };

  it("выполненные считаются по московским суткам: вчерашнее вечернее — не в счёт потолка, но держит паузу", () => {
    // 23:50 по Москве вчера — это −12 ч 10 мин от полудня.
    const lateYesterday = -(12 * 60 + 10);
    expect(networkTaskState("adsgram", history([lateYesterday, -60]))).toEqual({ doneToday: 1, lastDoneAt: at(-60) });
    expect(networkTaskState("taddy", history([-60]))).toEqual({ doneToday: 0, lastDoneAt: null });
    const midnight = history([lateYesterday]);
    const justAfter = new Date(midnight.dayStart.getTime() + 5 * MINUTE);
    expect(nextTaskAt(def, networkTaskState("adsgram", midnight), midnight.dayStart, justAfter)).toEqual(new Date(at(lateYesterday).getTime() + 30 * MINUTE));
  });

  it("пауза после выполненного, потолок — до следующих суток, а не до конца паузы", () => {
    expect(admitsTask(def, history([]), "adsgram", NOON)).toBe(true);
    expect(nextTaskAt(def, networkTaskState("adsgram", history([-10])), moscowDayStart(NOON), NOON)).toEqual(at(20));
    expect(admitsTask(def, history([-30]), "adsgram", NOON)).toBe(true);
    const capped = networkTaskState("adsgram", history([-120, -60]));
    expect(nextTaskAt(def, capped, moscowDayStart(NOON), NOON)).toEqual(new Date(moscowDayStart(NOON).getTime() + 24 * 60 * MINUTE));
  });

  it("строка из панели: пределы потолка и паузы, без награды — нельзя", () => {
    const valid = { networkKey: "adsgram", active: true, dailyCap: 5, pauseMin: 30, coins: 100, gems: 0, shards: 0 };
    expect(networkTaskSchema.safeParse(valid).success).toBe(true);
    expect(networkTaskSchema.safeParse({ ...valid, dailyCap: 0 }).success).toBe(false);
    expect(networkTaskSchema.safeParse({ ...valid, dailyCap: 51 }).success).toBe(false);
    expect(networkTaskSchema.safeParse({ ...valid, pauseMin: 4 }).success).toBe(false);
    expect(networkTaskSchema.safeParse({ ...valid, coins: 0 }).success).toBe(false);
    expect(networkTaskSchema.safeParse({ ...valid, title: "лишнее" }).success).toBe(false);
  });
});

describe("строка сети у игрока", () => {
  it("есть блок, адрес награды и строка включена — задание с сессией; повторное открытие — та же сессия", async () => {
    const { service, player, adsRepository } = await setup();
    const [first] = await service.view(player, NOON);
    expect(first).toMatchObject({
      network: "adsgram",
      title: "AdsGram",
      reward: { coins: 100, gems: 0, shards: 2 },
      doneToday: 0,
      dailyCap: 2,
      offer: { network: "adsgram", blockId: expect.stringMatching(/^task-\d+$/), debug: false, expiresAt: at(TASK_SESSION_TTL_MIN).toISOString() },
      nextAt: null,
    });
    const [again] = await service.view(player, at(5));
    expect(again?.offer?.sessionId).toBe(first?.offer?.sessionId);
    expect(adsRepository.sessions).toHaveLength(1);
  });

  it("строки нет: адрес награды не создан, блока нет, строка выключена, площадка не та", async () => {
    const closed = await setup({ secret: null });
    expect(await closed.service.view(closed.player, NOON)).toEqual([]);
    const noBlock = await setup({ blocks: [] });
    expect(await noBlock.service.view(noBlock.player, NOON)).toEqual([]);
    const off = await setup({ rows: [{ ...ROW, active: false }] });
    expect(await off.service.view(off.player, NOON)).toEqual([]);
    const vk = await setup();
    expect(await vk.service.view(await vk.ref("55", "vk"), NOON)).toEqual([]);
  });

  it("VIP задание сети не пропускает: пропуск заменяет ролик, а не подписку", async () => {
    const ctx = await setup();
    ctx.passes.register("vip", async () => true);
    const [row] = await ctx.service.view(ctx.player, NOON);
    expect(row?.offer).not.toBeNull();
    expect(ctx.adsRepository.sessions[0]).toMatchObject({ networkKey: "adsgram", status: "pending" });
  });
});

describe("подтверждение сети и награда", () => {
  it("подтверждение выполняет выданное задание и даёт награду строки ключом сессии; повтор — ничего", async () => {
    const { service, adTasks, player, wallet, adsRepository } = await setup();
    const [row] = await service.view(player, NOON);
    const sessionId = row?.offer?.sessionId ?? "";
    expect(await adTasks.confirm("adsgram", "telegram", TG_ID, at(3))).toBe("confirmed");
    expect(wallet.grants).toEqual([
      { accountId: player.accountId, resource: "coins", amount: 100, reason: "task_reward", source: "adtask:adsgram", idempotencyKey: `adtask:${player.accountId}:${sessionId}:coins`, at: at(3) },
      { accountId: player.accountId, resource: "shard_common", amount: 2, reason: "task_reward", source: "adtask:adsgram", idempotencyKey: `adtask:${player.accountId}:${sessionId}:shard_common`, at: at(3) },
    ]);
    expect(adsRepository.sessions[0]).toMatchObject({ status: "claimed", completedAt: at(3), claimedAt: at(3) });
    // Сеть повторила подтверждение: выданное задание уже забрано, нового нет.
    expect(await adTasks.confirm("adsgram", "telegram", TG_ID, at(4))).toBe("unmatched");
    expect(wallet.grants).toHaveLength(2);
  });

  it("без выданного задания, за чужого игрока и после истечения — награды нет", async () => {
    const { service, adTasks, player, wallet } = await setup();
    expect(await adTasks.confirm("adsgram", "telegram", TG_ID, NOON)).toBe("unmatched");
    expect(await adTasks.confirm("adsgram", "telegram", "999999", NOON)).toBe("unknown_player");
    await service.view(player, NOON);
    expect(await adTasks.confirm("adsgram", "telegram", TG_ID, at(TASK_SESSION_TTL_MIN + 1))).toBe("unmatched");
    expect(wallet.grants).toEqual([]);
  });

  it("после выполненного — пауза, потом следующее; потолок суток — до полуночи по Москве", async () => {
    const { service, adTasks, player } = await setup();
    await service.view(player, NOON);
    await adTasks.confirm("adsgram", "telegram", TG_ID, at(1));
    expect(await service.view(player, at(2))).toEqual([expect.objectContaining({ offer: null, doneToday: 1, nextAt: at(31).toISOString() })]);
    const [second] = await service.view(player, at(31));
    expect(second?.offer).not.toBeNull();
    await adTasks.confirm("adsgram", "telegram", TG_ID, at(40));
    const midnight = new Date(moscowDayStart(NOON).getTime() + 24 * 60 * MINUTE);
    expect(await service.view(player, at(200))).toEqual([expect.objectContaining({ offer: null, doneToday: 2, nextAt: midnight.toISOString() })]);
    const [tomorrow] = await service.view(player, new Date(midnight.getTime() + MINUTE));
    expect(tomorrow).toMatchObject({ doneToday: 0, nextAt: null, offer: expect.objectContaining({ network: "adsgram" }) });
  });

  it("два экрана разом заводят одну сессию: потолок не обходится гонкой", async () => {
    const { service, player, adsRepository } = await setup({ rows: [{ ...ROW, dailyCap: 1 }] });
    const views = await Promise.all([service.view(player, NOON), service.view(player, NOON), service.view(player, NOON)]);
    expect(new Set(views.map(([row]) => row?.offer?.sessionId)).size).toBe(1);
    expect(adsRepository.sessions).toHaveLength(1);
  });

  it("выдача сорвалась — сеть получает ошибку, повтор её подтверждения дожимает награду тем же ключом", async () => {
    const { service, adTasks, player, wallet, adsRepository } = await setup();
    await service.view(player, NOON);
    wallet.failNext = true;
    await expect(adTasks.confirm("adsgram", "telegram", TG_ID, at(1))).rejects.toThrow("кошелёк недоступен");
    expect(adsRepository.sessions[0]).toMatchObject({ status: "completed", claimedAt: null });
    expect(await adTasks.confirm("adsgram", "telegram", TG_ID, at(2))).toBe("confirmed");
    expect(wallet.grants.map((grant) => grant.resource)).toEqual(["coins", "shard_common"]);
    expect(adsRepository.sessions[0]).toMatchObject({ status: "claimed" });
  });

  it("сеть повторять не стала — награду дожимает следующее открытие экрана", async () => {
    const { service, adTasks, player, wallet, adsRepository } = await setup();
    await service.view(player, NOON);
    wallet.failNext = true;
    await expect(adTasks.confirm("adsgram", "telegram", TG_ID, at(1))).rejects.toThrow();
    await service.view(player, at(5));
    expect(wallet.grants).toHaveLength(2);
    expect(adsRepository.sessions[0]).toMatchObject({ status: "claimed" });
  });

  it("клиент сам задание не выполнит: шаг «досмотрено» у сессии задания не принимается", async () => {
    const { service, ads, player, adsRepository } = await setup();
    const [row] = await service.view(player, NOON);
    await expect(ads.report(player.accountId, row?.offer?.sessionId ?? "", { kind: "completed" }, at(1))).rejects.toMatchObject({ code: "ad_session_closed" });
    expect(adsRepository.sessions[0]).toMatchObject({ status: "pending", completedAt: null });
  });
});

describe("строка сети в панели", () => {
  it("готовность: блок в «Рекламе» и адрес награды; правка — в аудит, игроки видят новые числа", async () => {
    const ctx = await setup({ secret: null });
    const owner = await ctx.ref(OWNER_ID);
    const designer = await ctx.ref("31");
    await ctx.rolesRepository.grant(designer.accountId, "game_designer", null);
    expect(await ctx.service.catalog(owner)).toEqual([expect.objectContaining({ networkKey: "adsgram", title: "AdsGram", ready: { block: true, confirm: false, confirmWith: "Адрес награды за задание AdsGram" } })]);
    ctx.secrets.value = SECRET;
    expect((await ctx.service.catalog(designer))[0]?.ready).toMatchObject({ block: true, confirm: true });

    const saved = await ctx.service.save(designer, { networkKey: "adsgram", active: true, dailyCap: 3, pauseMin: 60, coins: 150, gems: 0, shards: 0 }, at(1));
    expect(saved).toMatchObject({ dailyCap: 3, pauseMin: 60, coins: 150, updatedBy: designer.accountId });
    const [entry] = await ctx.rolesRepository.recentAudit(10);
    expect(entry).toMatchObject({ action: "tasks.network.update", target: "adsgram", before: { dailyCap: 2, coins: 100 }, after: { dailyCap: 3, coins: 150 } });
    const [row] = await ctx.service.view(ctx.player, at(2));
    expect(row).toMatchObject({ dailyCap: 3, reward: { coins: 150, gems: 0, shards: 0 } });
  });

  it("строку правит только тот, у кого есть право на задания; незаведённую сеть — нельзя", async () => {
    const ctx = await setup();
    const stranger = await ctx.ref("32");
    const owner = await ctx.ref(OWNER_ID);
    await expect(ctx.service.catalog(stranger)).rejects.toMatchObject({ code: "forbidden" });
    await expect(ctx.service.save(owner, { networkKey: "richads", active: true, dailyCap: 3, pauseMin: 60, coins: 150, gems: 0, shards: 0 })).rejects.toMatchObject({ code: "task_not_found" });
  });
});

describe("адрес награды AdsGram", () => {
  let app: NestFastifyApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(secret: string | null, confirm: (userId: string) => Promise<"confirmed" | "unmatched" | "unknown_player">) {
    const calls: string[] = [];
    const tasks = {
      confirm: async (_network: string, _platform: string, userId: string) => {
        calls.push(userId);
        return await confirm(userId);
      },
    };
    @Module({
      controllers: [AdsgramRewardController],
      providers: [
        { provide: AdTasks, useValue: tasks },
        { provide: SECRETS_READER, useValue: secretsOf(secret) },
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule as Type<unknown>, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { app, calls };
  }

  it("путь — тот же, что панель отдаёт для кабинета; верный секрет — подтверждение и 200", async () => {
    const { app: server, calls } = await start(SECRET, async () => "confirmed");
    const response = await server.inject({ method: "GET", url: `${ADSGRAM_REWARD_PATH}/${SECRET}/${TG_ID}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { rewarded: true } });
    expect(calls).toEqual([TG_ID]);
  });

  it("подтверждать нечего — всё равно 200: сеть не должна повторять напрасно", async () => {
    const { app: server } = await start(SECRET, async () => "unmatched");
    const response = await server.inject({ method: "GET", url: `${ADSGRAM_REWARD_PATH}/${SECRET}/${TG_ID}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { rewarded: false } });
  });

  it("чужой секрет — 401, кривой id — 400, адрес не создан — 404; до подтверждения не доходит", async () => {
    const { app: server, calls } = await start(SECRET, async () => "confirmed");
    expect((await server.inject({ method: "GET", url: `${ADSGRAM_REWARD_PATH}/${SECRET.slice(0, -1)}x/${TG_ID}` })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: `${ADSGRAM_REWARD_PATH}/${SECRET}/[userId]` })).statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url: `${ADSGRAM_REWARD_PATH}/${SECRET}/-5` })).statusCode).toBe(400);
    expect(calls).toEqual([]);
    await app?.close();
    const { app: closed } = await start(null, async () => "confirmed");
    expect((await closed.inject({ method: "GET", url: `${ADSGRAM_REWARD_PATH}/${SECRET}/${TG_ID}` })).statusCode).toBe(404);
  });

  it("сорвалась выдача — сеть получает ошибку и повторит", async () => {
    const { app: server } = await start(SECRET, async () => {
      throw new Error("кошелёк недоступен");
    });
    expect((await server.inject({ method: "GET", url: `${ADSGRAM_REWARD_PATH}/${SECRET}/${TG_ID}` })).statusCode).toBe(500);
  });

  it("секреты сравниваются хэшами: длина не важна, совпадение — только точное", () => {
    expect(sameSecret(SECRET, SECRET)).toBe(true);
    expect(sameSecret(SECRET, `${SECRET}x`)).toBe(false);
    expect(sameSecret("", SECRET)).toBe(false);
  });
});
