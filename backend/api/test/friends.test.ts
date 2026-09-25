import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken, type AccessTokenClaims } from "../src/modules/auth/access-token.js";
import { ACCOUNT_REPOSITORY, type Account } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { AuthHooks, PLAIN_LOGIN, type LoginEvent } from "../src/modules/auth/auth-hooks.js";
import { parseStartParam } from "../src/modules/attribution/start-param.js";
import { FriendsController } from "../src/modules/friends/friends.controller.js";
import { FRIENDS_REPOSITORY } from "../src/modules/friends/friends.repository.js";
import { FRIENDS_RULES } from "../src/modules/friends/friends-rules.js";
import { FriendsService } from "../src/modules/friends/friends.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryFriendsRepository, shiftDay } from "./helpers/memory-friends.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { GIFT_RULES } from "../src/modules/friends/friends-rules.js";

/**
 * Друзья (docs/35-stage4-plan.md, WP14): ссылка дружбы делает друзьями без
 * лишних действий, дружба взаимна и с потолком, встречная заявка — согласие,
 * чужая площадка и заблокированный для раздела не существуют.
 */

function config(): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
}

let accounts: MemoryAccountRepository;
let repository: MemoryFriendsRepository;
let service: FriendsService;
let wallet: FakeWallet;

/** Кошелёк с ключом идемпотентности — ровно то, на что опираются подарки. */
class FakeWallet {
  readonly grants = new Map<string, GrantInput>();
  async grant(input: GrantInput): Promise<GrantResult> {
    const duplicate = this.grants.has(input.idempotencyKey);
    if (!duplicate) this.grants.set(input.idempotencyKey, input);
    return { credited: duplicate ? 0 : input.amount, balance: 0, duplicate };
  }
}

async function player(platformUserId: string, platform: "telegram" | "vk" = "telegram"): Promise<Account> {
  return await accounts.upsert({ platform, platformUserId, displayName: `Игрок ${platformUserId}`, username: null, photoUrl: null }, Date.now());
}

function claims(account: Account): AccessTokenClaims {
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

function login(account: Account, startParam: string | null, overrides: Partial<LoginEvent> = {}): LoginEvent {
  return {
    ...PLAIN_LOGIN,
    accountId: account.accountId,
    platform: account.platform,
    place: "miniapp",
    startParam: parseStartParam(startParam),
    created: true,
    at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  accounts = new MemoryAccountRepository();
  repository = new MemoryFriendsRepository(accounts);
  wallet = new FakeWallet();
  service = new FriendsService(config(), repository, accounts, new AuthHooks(), wallet as unknown as WalletService);
});

describe("ссылка дружбы", () => {
  it("открыл ссылку — друзья без лишних действий, у обоих в списке", async () => {
    const owner = await player("1");
    const guest = await player("2");
    const { startParam } = await service.link(owner.accountId);
    expect(startParam).toMatch(/^f-[A-Za-z0-9]{12}$/);
    expect((await service.link(owner.accountId)).startParam).toBe(startParam);

    await service.onLogin(login(guest, startParam));
    expect((await service.view(owner.accountId)).friends.map((friend) => friend.accountId)).toEqual([guest.accountId]);
    expect((await service.view(guest.accountId)).friends[0]).toMatchObject({ accountId: owner.accountId, source: "link" });
  });

  it("своя ссылка, чужая площадка, заблокированный владелец, повторный вход и мусорный код — не дружба", async () => {
    const owner = await player("1");
    const { startParam } = await service.link(owner.accountId);
    const vkGuest = await player("2", "vk");
    const guest = await player("3");

    await service.onLogin(login(owner, startParam));
    await service.onLogin(login(vkGuest, startParam, { platform: "vk" }));
    await service.onLogin(login(guest, startParam, { reason: "reauth" }));
    await service.onLogin(login(guest, "f-NoSuchCode99"));
    expect(repository.pairs.size).toBe(0);

    await accounts.setBan(owner.accountId, { at: new Date(), reason: "читы" });
    await service.onLogin(login(guest, startParam));
    expect(repository.pairs.size).toBe(0);
  });

  it("потолок друзей держит и ссылку", async () => {
    const owner = await player("1");
    const { startParam } = await service.link(owner.accountId);
    for (let index = 0; index < FRIENDS_RULES.maxFriends; index++) await service.onLogin(login(await player(`g${index}`), startParam));
    const late = await player("late");
    await service.onLogin(login(late, startParam));
    expect((await service.view(owner.accountId)).friends).toHaveLength(FRIENDS_RULES.maxFriends);
    expect((await service.view(late.accountId)).friends).toHaveLength(0);
  });
});

describe("заявки", () => {
  it("заявка ждёт ответа, принятие делает друзьями и убирает заявку", async () => {
    const ann = await player("1");
    const bob = await player("2");
    expect(await service.request(claims(ann), bob.accountId)).toEqual({ status: "requested" });
    expect((await service.view(bob.accountId)).incoming.map((row) => row.accountId)).toEqual([ann.accountId]);
    expect((await service.view(ann.accountId)).outgoing.map((row) => row.accountId)).toEqual([bob.accountId]);

    await service.accept(claims(bob), ann.accountId);
    const view = await service.view(bob.accountId);
    expect(view.friends[0]).toMatchObject({ accountId: ann.accountId, source: "request" });
    expect(view.incoming).toEqual([]);
  });

  it("встречная заявка — уже согласие", async () => {
    const ann = await player("1");
    const bob = await player("2");
    await service.request(claims(ann), bob.accountId);
    expect(await service.request(claims(bob), ann.accountId)).toEqual({ status: "friends" });
    expect(await repository.areFriends(ann.accountId, bob.accountId)).toBe(true);
    expect(repository.requests.size).toBe(0);
  });

  it("себя, чужую площадку и заблокированного позвать нельзя; уже друзьям заявка не нужна", async () => {
    const ann = await player("1");
    const vk = await player("2", "vk");
    const banned = await player("3");
    await accounts.setBan(banned.accountId, { at: new Date(), reason: "читы" });

    await expect(service.request(claims(ann), ann.accountId)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.request(claims(ann), vk.accountId)).rejects.toMatchObject({ code: "friend_not_found" });
    await expect(service.request(claims(ann), banned.accountId)).rejects.toMatchObject({ code: "friend_not_found" });

    const bob = await player("4");
    await service.request(claims(ann), bob.accountId);
    await service.accept(claims(bob), ann.accountId);
    expect(await service.request(claims(ann), bob.accountId)).toEqual({ status: "friends" });
    expect(repository.requests.size).toBe(0);
  });

  it("принять можно только заявку, которая есть; отклонить и отменить — без следа", async () => {
    const ann = await player("1");
    const bob = await player("2");
    await expect(service.accept(claims(bob), ann.accountId)).rejects.toMatchObject({ code: "friend_request_not_found" });

    await service.request(claims(ann), bob.accountId);
    expect(await service.decline(claims(bob), ann.accountId)).toEqual({ declined: true });
    await service.request(claims(ann), bob.accountId);
    expect(await service.cancel(claims(ann), bob.accountId)).toEqual({ cancelled: true });
    expect(repository.requests.size).toBe(0);
  });

  it("потолок входящих заявок отвечает понятной ошибкой, а удаление друга — взаимно", async () => {
    const star = await player("star");
    for (let index = 0; index < FRIENDS_RULES.maxIncomingRequests; index++) await service.request(claims(await player(`f${index}`)), star.accountId);
    await expect(service.request(claims(await player("late")), star.accountId)).rejects.toMatchObject({ code: "friend_limit" });

    const ann = await player("1");
    const bob = await player("2");
    await service.request(claims(ann), bob.accountId);
    await service.accept(claims(bob), ann.accountId);
    expect(await service.remove(claims(bob), ann.accountId)).toEqual({ removed: true });
    expect(await repository.areFriends(ann.accountId, bob.accountId)).toBe(false);
  });
});

describe("подарки", () => {
  async function friendsPair(): Promise<[Account, Account]> {
    const ann = await player("1");
    const bob = await player("2");
    await service.request(claims(ann), bob.accountId);
    await service.accept(claims(bob), ann.accountId);
    return [ann, bob];
  }

  it("подарок — раз в сутки и только другу; получатель видит его и забирает монетами", async () => {
    const [ann, bob] = await friendsPair();
    const stranger = await player("3");
    await expect(service.sendGift(claims(ann), stranger.accountId)).rejects.toMatchObject({ code: "friend_not_found" });

    expect(await service.sendGift(claims(ann), bob.accountId)).toEqual({ sent: true });
    expect(await service.sendGift(claims(ann), bob.accountId)).toEqual({ sent: false });
    expect((await service.view(ann.accountId)).gifts.sentToday).toEqual([bob.accountId]);
    expect((await service.view(bob.accountId)).gifts).toMatchObject({ pending: 1, claimableToday: 1, coins: GIFT_RULES.coins });

    expect(await service.claimGifts(claims(bob))).toEqual({ claimed: 1, coins: GIFT_RULES.coins });
    expect([...wallet.grants.values()][0]).toMatchObject({ accountId: bob.accountId, reason: "friend_gift", amount: GIFT_RULES.coins });
    expect(await service.claimGifts(claims(bob))).toEqual({ claimed: 0, coins: 0 });

    repository.today = shiftDay(repository.today, 1);
    expect(await service.sendGift(claims(ann), bob.accountId)).toEqual({ sent: true });
  });

  it("забрать можно не больше потолка суток, остальное ждёт следующих; старые сгорают", async () => {
    const receiver = await player("receiver");
    const extra = 3;
    for (let index = 0; index < GIFT_RULES.maxClaimsPerDay + extra; index++) {
      const giver = await player(`g${index}`);
      await service.request(claims(giver), receiver.accountId);
      await service.accept(claims(receiver), giver.accountId);
      await service.sendGift(claims(giver), receiver.accountId);
    }
    expect((await service.claimGifts(claims(receiver))).claimed).toBe(GIFT_RULES.maxClaimsPerDay);
    expect((await service.view(receiver.accountId)).gifts).toMatchObject({ pending: extra, claimableToday: 0 });

    repository.today = shiftDay(repository.today, GIFT_RULES.maxAgeDays);
    expect((await service.view(receiver.accountId)).gifts.pending).toBe(0);
  });

  it("начисленный, но не помеченный подарок кошелёк узнаёт по ключу — дважды не платит", async () => {
    const [ann, bob] = await friendsPair();
    await service.sendGift(claims(ann), bob.accountId);
    const day = repository.today;
    await wallet.grant({ accountId: bob.accountId, resource: "coins", amount: GIFT_RULES.coins, reason: "friend_gift", idempotencyKey: `friend_gift:${ann.accountId}:${bob.accountId}:${day}` });

    expect(await service.claimGifts(claims(bob))).toEqual({ claimed: 1, coins: 0 });
    expect(wallet.grants.size).toBe(1);
  });
});

describe("HTTP раздела друзей", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(): Promise<NestFastifyApplication> {
    const cfg = config();
    @Module({
      controllers: [FriendsController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: accounts },
        { provide: FRIENDS_REPOSITORY, useValue: repository },
        { provide: FriendsService, useValue: service },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule as Type<unknown>, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  async function bearer(account: Account): Promise<string> {
    return `Bearer ${await signAccessToken(claims(account), secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now())}`;
  }

  it("без токена — 401; с токеном — ссылка, заявка и список", async () => {
    const target = await start();
    const ann = await player("1");
    const bob = await player("2");
    expect((await target.inject({ method: "GET", url: "/api/v1/friends" })).statusCode).toBe(401);

    const link = await target.inject({ method: "POST", url: "/api/v1/friends/link", headers: { authorization: await bearer(ann) } });
    expect(link.json().data.startParam).toMatch(/^f-/);

    const sent = await target.inject({ method: "POST", url: "/api/v1/friends/requests", headers: { authorization: await bearer(ann) }, payload: { accountId: bob.accountId } });
    expect(sent.json()).toEqual({ data: { status: "requested" } });

    const accepted = await target.inject({ method: "POST", url: `/api/v1/friends/requests/${ann.accountId}/accept`, headers: { authorization: await bearer(bob) } });
    expect(accepted.json()).toEqual({ data: { status: "friends" } });

    const view = await target.inject({ method: "GET", url: "/api/v1/friends", headers: { authorization: await bearer(bob) } });
    expect(view.json().data.friends[0].accountId).toBe(ann.accountId);

    const gift = await target.inject({ method: "POST", url: `/api/v1/friends/${bob.accountId}/gift`, headers: { authorization: await bearer(ann) } });
    expect(gift.json()).toEqual({ data: { sent: true } });
    const claim = await target.inject({ method: "POST", url: "/api/v1/friends/gifts/claim", headers: { authorization: await bearer(bob) } });
    expect(claim.json()).toEqual({ data: { claimed: 1, coins: GIFT_RULES.coins } });
  });

  it("мусор в теле и в пути — 400, чужой игрок — 404", async () => {
    const target = await start();
    const ann = await player("1");
    const auth = { authorization: await bearer(ann) };
    expect((await target.inject({ method: "POST", url: "/api/v1/friends/requests", headers: auth, payload: { accountId: "не uuid" } })).statusCode).toBe(400);
    expect((await target.inject({ method: "DELETE", url: "/api/v1/friends/abc", headers: auth })).statusCode).toBe(400);
    const missing = await target.inject({ method: "POST", url: "/api/v1/friends/requests", headers: auth, payload: { accountId: "3c8f3a52-2d4e-4c55-9d0e-6f3b2a1c0d9e" } });
    expect(missing.json()).toMatchObject({ error: { code: "friend_not_found" } });
  });
});
