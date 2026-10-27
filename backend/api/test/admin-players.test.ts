import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { ForbiddenError, ValidationError } from "../src/common/domain-error.js";
import { AccountNotFoundError } from "../src/modules/admin/admin-errors.js";
import { AdminPlayersService } from "../src/modules/admin/admin-players.service.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import type { SessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import type { AuthService } from "../src/modules/auth/auth.service.js";
import type { FunnelMilestones, FunnelRepository } from "../src/modules/funnel/funnel.repository.js";
import type { FlagSplit } from "../src/modules/funnel/flag-split-report.js";
import { EMPTY_SPLIT_GROUP } from "./helpers/flag-split.js";
import type { MessagingService } from "../src/modules/messaging/messaging.service.js";
import { playerListQuerySchema } from "../src/modules/player-list/player-list-query.js";
import type { PlayerListRepository, PlayerListRow, PlayerPage } from "../src/modules/player-list/player-list.repository.js";
import { PlayerListService } from "../src/modules/player-list/player-list.service.js";
import type { ProgressService } from "../src/modules/progress/progress.service.js";
import { RestrictionsHooks } from "../src/modules/restrictions/restrictions-hooks.js";
import { RestrictionsService } from "../src/modules/restrictions/restrictions.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import type { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import type { TestNoticeService } from "../src/modules/test-notice/test-notice.service.js";
import type { WalletService } from "../src/modules/wallet/wallet.service.js";
import { emptyBalances } from "../src/modules/wallet/wallet-types.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { memoryNotifications } from "./helpers/memory-notifications.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Карточка игрока и блокировка в панели (docs/29-admin-panel.md §3.3, §3.4).
 * Закрепляется граница прав: модератор видит карточку без персональных
 * данных и без платежей, просмотр с правом уходит в журнал, блокировка
 * отзывает сессии и пишется с прежним состоянием.
 */

const NOW = new Date(Date.UTC(2026, 8, 26, 12));
const OWNER_ID = "777000111";

function config(): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_PANEL_ENABLED: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
}

const MILESTONES: FunnelMilestones = {
  enteredAt: NOW,
  appOpenedAt: NOW,
  firstRunStartedAt: null,
  firstRunFinishedAt: null,
  runsRecorded: 0,
  runs2At: null,
  runs5At: null,
  returnedD1At: null,
  returnedD7At: null,
  firstPurchaseAt: null,
};

class FakeFunnel implements FunnelRepository {
  async entered(): Promise<void> {}
  async appOpened(): Promise<void> {}
  async firstRunStarted(): Promise<void> {}
  async runRecorded(): Promise<void> {}
  async firstPurchase(): Promise<void> {}
  async milestones(): Promise<FunnelMilestones | null> {
    return MILESTONES;
  }
  async report(): Promise<[]> {
    return [];
  }
  async flagSplit(): Promise<FlagSplit> {
    return { share: EMPTY_SPLIT_GROUP, rest: EMPTY_SPLIT_GROUP };
  }
}

function setup() {
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const purchases = new MemoryPurchasesRepository();
  const store = new MemoryAdminSessionStore();
  const cfg = config();
  const roles = new RolesService(cfg, rolesRepository, accounts);
  const adminSessions = new AdminSessionService(cfg, accounts, store, roles);
  const gameSessionsRevoked: string[] = [];

  const sessions = { record: async () => "recorded" as const, acquisition: async () => null, recentIpPrefixes: async () => [], lastSessionBefore: async () => null } satisfies SessionsRepository;
  const messaging = { state: async () => ({ canMessage: true, reason: "entered" as const, changedAt: NOW }) } as unknown as MessagingService;
  const progress = { view: async () => ({ xp: 120, level: 2, nextLevelXp: 300, levelXp: 150 }) } as unknown as ProgressService;
  const runs = { profile: async () => ({ runs: 3, totalKills: 40, totalSurvivalSec: 500, best: { easy: null, normal: null, hard: null }, recent: [] }) } as unknown as RunsViewService;
  const wallet = { balances: async () => ({ ...emptyBalances(), coins: 15 }), recentEntries: async () => [] } as unknown as WalletService;
  const auth = {
    logoutEverywhere: async (accountId: string) => {
      gameSessionsRevoked.push(accountId);
      return 2;
    },
  } as unknown as AuthService;

  const notifications = memoryNotifications();
  const testNotice = { acceptance: async () => ({ version: 1, acceptedAt: NOW, firstAcceptedAt: NOW }) } as unknown as TestNoticeService;
  const restrictionsRepository = new MemoryRestrictionsRepository();
  const restrictions = new RestrictionsService(restrictionsRepository, accounts, roles, restrictionsGate(restrictionsRepository), new RestrictionsHooks());
  // Что поддержка может сделать с покупкой, решает сервис оплаты (T-0037); здесь важно, кому карточка это показывает.
  const support = { actionsFor: () => ["refund"] } as never;
  const service = new AdminPlayersService(accounts, new FakeFunnel(), sessions, purchases, roles, messaging, progress, runs, wallet, auth, adminSessions, notifications.service, testNotice, restrictions, support);
  return { accounts, rolesRepository, purchases, store, roles, service, gameSessionsRevoked, feed: notifications.repository, restrictionsRepository, restrictions };
}

async function player(accounts: MemoryAccountRepository, platformUserId = String(500_000 + Math.floor(Math.random() * 1000))) {
  return await accounts.upsert({ platform: "telegram", platformUserId, displayName: "Путник", username: "wanderer", photoUrl: null }, NOW.getTime());
}

const owner: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: OWNER_ID };

describe("карточка игрока", () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => {
    s = setup();
  });

  it("владелец видит всё: персональные данные, покупки — и просмотр в журнале", async () => {
    const target = await player(s.accounts);
    const card = await s.service.card(owner, target.accountId);

    expect(card.account.pii).toEqual({ platformUserId: target.platformUserId, username: "wanderer" });
    expect(card.purchases).toEqual([]);
    expect(card.funnel).toEqual(MILESTONES);
    expect(card.progress).toMatchObject({ level: 2 });
    expect(card.wallet.balances.coins).toBe(15);
    expect(card.messaging?.canMessage).toBe(true);
    expect(card.testNotice).toEqual({ version: 1, acceptedAt: NOW, firstAcceptedAt: NOW });
    expect(s.rolesRepository.entries.map((entry) => [entry.action, entry.target])).toEqual([["players.pii.view", target.accountId]]);
  });

  it("модератор видит карточку без персональных данных и без платежей, журнал молчит", async () => {
    const moderator = await player(s.accounts, "600001");
    await s.rolesRepository.grant(moderator.accountId, "moderator", null);
    const target = await player(s.accounts);

    const card = await s.service.card({ accountId: moderator.accountId, platform: "telegram", platformUserId: "600001" }, target.accountId);

    expect(card.account.pii).toBeNull();
    expect(card.purchases).toBeNull();
    expect(card.roles).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
  });

  it("покупка в карточке приходит с тем, что поддержка может сделать: у админа и владельца — actions, у геймдизайнера (выручку видит, права поддержки нет) — пусто (T-0037)", async () => {
    const target = await player(s.accounts);
    s.purchases.rows.set("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
      purchaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      accountId: target.accountId,
      product: "shop_item",
      runId: null,
      continueNo: null,
      elapsedSec: null,
      sku: "starter_pack",
      priceStars: 50,
      chargedStars: 50,
      mode: "live",
      status: "paid",
      telegramChargeId: "charge-1",
      invoicedAt: NOW,
      paidAt: NOW,
      refundReason: null,
      refundRequestedAt: null,
      refundedAt: null,
      fulfilledAt: NOW,
      renewalOf: null,
    });
    const admin = await player(s.accounts, "600010");
    await s.rolesRepository.grant(admin.accountId, "admin", null);
    const designer = await player(s.accounts, "600011");
    await s.rolesRepository.grant(designer.accountId, "game_designer", null);
    const refOf = (account: typeof admin, platformUserId: string): AccountRef => ({ accountId: account.accountId, platform: "telegram", platformUserId });

    const asAdmin = await s.service.card(refOf(admin, "600010"), target.accountId);
    const asDesigner = await s.service.card(refOf(designer, "600011"), target.accountId);
    const asOwner = await s.service.card(owner, target.accountId);

    expect(asAdmin.purchases?.map((purchase) => purchase.actions)).toEqual([["refund"]]);
    expect(asOwner.purchases?.map((purchase) => purchase.actions)).toEqual([["refund"]]);
    expect(asDesigner.purchases?.map((purchase) => [purchase.purchaseId, purchase.actions])).toEqual([["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", []]]);
  });

  it("неизвестный аккаунт — 404", async () => {
    await expect(s.service.card(owner, randomUUID())).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it("поиск: по идентификатору, юзернейму и имени; без права на ПДн — строки без идентификаторов", async () => {
    const target = await player(s.accounts, "123456");
    const rows = await s.service.search(owner, "@wand", 10);
    expect(rows.map((row) => row.accountId)).toEqual([target.accountId]);
    expect(rows[0]?.pii?.platformUserId).toBe("123456");
    expect(s.rolesRepository.entries.map((entry) => entry.action)).toEqual(["players.pii.view"]);

    const moderator = await player(s.accounts, "600002");
    await s.rolesRepository.grant(moderator.accountId, "moderator", null);
    const blind = await s.service.search({ accountId: moderator.accountId, platform: "telegram", platformUserId: "600002" }, "123456", 10);
    expect(blind[0]?.pii).toBeNull();
    expect((await s.service.search(owner, "никого", 10)).length).toBe(0);
  });
});

describe("блокировка", () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => {
    s = setup();
  });

  it("помечает аккаунт, отзывает сессии игры и панели, пишет было → стало", async () => {
    const target = await player(s.accounts);
    await s.store.put(hashSessionToken("t"), { accountId: target.accountId, platform: "telegram", platformUserId: target.platformUserId, issuedAtMs: 1, expiresAtMs: NOW.getTime() + 1000 });

    const result = await s.service.ban(owner, target.accountId, "накрутка", NOW);

    // Прежняя кнопка — бессрочная блокировка целиком: игрок видит причину
    // шаблона, текст модератора — комментарий для команды.
    const shown = "Аккаунт заблокирован бессрочно. Причина: Нарушение правил игры";
    expect(result.account.banned).toEqual({ at: NOW.toISOString(), reason: shown });
    expect(result.revokedSessions).toBe(3);
    expect(s.gameSessionsRevoked).toEqual([target.accountId]);
    expect(s.store.sessions.size).toBe(0);
    expect((await s.accounts.byId(target.accountId))?.banReason).toBe(shown);
    expect(s.restrictionsRepository.rows).toMatchObject([{ accountId: target.accountId, kind: "all", endsAt: null, reason: "other", comment: "накрутка", notify: true }]);
    expect(s.rolesRepository.entries.at(-1)).toMatchObject({
      action: "players.restrict",
      target: target.accountId,
      after: { restrictions: [{ kind: "all", endsAt: null, reason: "other", comment: "накрутка", notify: true }] },
    });
  });

  it("без права — 403, себя — 400, несуществующего — 404", async () => {
    const target = await player(s.accounts);
    const nobody: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: "1" };
    await expect(s.service.ban(nobody, target.accountId, "нельзя", NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.service.ban(owner, owner.accountId, "себя", NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(s.service.ban(owner, randomUUID(), "пусто", NOW)).rejects.toBeInstanceOf(AccountNotFoundError);
    expect(s.gameSessionsRevoked).toEqual([]);
  });

  it("разблокировка снимает отметку и пишется один раз, повтор — тихо", async () => {
    const target = await player(s.accounts);
    await s.service.ban(owner, target.accountId, "спор", NOW);

    const first = await s.service.unban(owner, target.accountId);
    expect(first.account.banned).toBeNull();
    const again = await s.service.unban(owner, target.accountId);
    expect(again.account.banned).toBeNull();

    expect(s.rolesRepository.entries.map((entry) => entry.action)).toEqual(["players.restrict", "players.unrestrict"]);
    expect(s.restrictionsRepository.rows[0]).toMatchObject({ liftComment: "Блокировка снята в карточке игрока" });
  });
});

describe("сообщение команды", () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => {
    s = setup();
  });

  it("ложится в ленту игрока видом team_message и пишется в журнал с текстом", async () => {
    const target = await player(s.accounts);
    const result = await s.service.message(owner, target.accountId, "Поправили начисление за вчерашний забег", "panel-key-0001", NOW);

    expect(result).toEqual({ duplicate: false });
    expect(s.feed.of(target.accountId)).toEqual([{ kind: "team_message", payload: { text: "Поправили начисление за вчерашний забег" } }]);
    expect(s.rolesRepository.entries.at(-1)).toMatchObject({ action: "players.message", target: target.accountId, after: { text: "Поправили начисление за вчерашний забег" } });
  });

  it("повтор той же кнопки — ни второй строки в ленте, ни второй записи в журнале", async () => {
    const target = await player(s.accounts);
    await s.service.message(owner, target.accountId, "Привет", "panel-key-0002", NOW);
    const again = await s.service.message(owner, target.accountId, "Привет", "panel-key-0002", NOW);
    const other = await s.service.message(owner, target.accountId, "Привет", "panel-key-0003", NOW);

    expect(again).toEqual({ duplicate: true });
    expect(other).toEqual({ duplicate: false });
    expect(s.feed.of(target.accountId)).toHaveLength(2);
    expect(s.rolesRepository.entries.filter((entry) => entry.action === "players.message")).toHaveLength(2);
  });

  it("модератор может, без права — 403, несуществующему — 404, и в ленту ничего не попадает", async () => {
    const target = await player(s.accounts);
    const moderator = await player(s.accounts, "600003");
    await s.rolesRepository.grant(moderator.accountId, "moderator", null);
    const asModerator: AccountRef = { accountId: moderator.accountId, platform: "telegram", platformUserId: "600003" };
    const nobody: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: "1" };

    await expect(s.service.message(nobody, target.accountId, "Нельзя", "panel-key-0004", NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.service.message(owner, randomUUID(), "Некому", "panel-key-0005", NOW)).rejects.toBeInstanceOf(AccountNotFoundError);
    expect(s.feed.of(target.accountId)).toEqual([]);

    expect(await s.service.message(asModerator, target.accountId, "Жалобу рассмотрели", "panel-key-0006", NOW)).toEqual({ duplicate: false });
  });
});

describe("скрытое ограничение «Отдельная доска» в панели (T-0112)", () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => {
    s = setup();
  });

  const hiddenInput = { kinds: ["separate_board" as const], endsAt: null, reason: "leaderboard_cheat" as const, comment: "проверка", notify: false };

  async function moderatorOf(id: string): Promise<AccountRef> {
    const account = await player(s.accounts, id);
    await s.rolesRepository.grant(account.accountId, "moderator", null);
    return { accountId: account.accountId, platform: "telegram", platformUserId: id };
  }

  it("владелец накладывает через карточку: в ответе строка вида, сессии не отзываются, журнал — `players.board.set`", async () => {
    const target = await player(s.accounts);
    const result = await s.service.restrict(owner, target.accountId, hiddenInput, NOW);

    expect(result.restrictions.map((view) => [view.kind, view.notify])).toEqual([["separate_board", false]]);
    expect(result.revokedSessions).toBe(0);
    expect(s.gameSessionsRevoked).toEqual([]);
    expect(s.rolesRepository.entries.map((entry) => entry.action)).toEqual(["players.board.set"]);
  });

  it("модератор получает тот же отказ, что на кривое тело: вид не выдаётся ни ответом, ни журналом", async () => {
    const target = await player(s.accounts);
    const moderator = await moderatorOf("600010");

    const refusal = s.service.restrict(moderator, target.accountId, hiddenInput, NOW);
    await expect(refusal).rejects.toBeInstanceOf(ValidationError);
    await expect(refusal).rejects.toThrow("Некорректное ограничение: нужны виды, срок и причина");
    expect(s.restrictionsRepository.rows).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
  });

  it("история игрока в карточке: у модератора строки вида нет, у владельца — есть", async () => {
    const target = await player(s.accounts);
    const moderator = await moderatorOf("600011");
    await s.service.restrict(owner, target.accountId, hiddenInput, NOW);
    await s.service.restrict(owner, target.accountId, { ...hiddenInput, kinds: ["promo_codes" as const], reason: "promo_abuse" as const, notify: true }, new Date(NOW.getTime() + 1000));

    expect((await s.restrictions.history(owner, target.accountId, NOW)).map((view) => view.kind)).toEqual(["promo_codes", "separate_board"]);
    expect((await s.restrictions.history(moderator, target.accountId, NOW)).map((view) => view.kind)).toEqual(["promo_codes"]);
  });
});

describe("список игроков и скрытое ограничение (T-0112)", () => {
  function row(index: number, restrictions: string[]): PlayerListRow {
    return {
      accountId: `00000000-0000-4000-8000-00000000001${String(index)}`,
      platform: "telegram",
      displayName: `Игрок ${String(index)}`,
      photoUrl: null,
      platformUserId: String(800 + index),
      username: null,
      createdAt: new Date(Date.UTC(2026, 8, index + 1)),
      lastSeenAt: new Date(Date.UTC(2026, 8, 30)),
      bannedAt: null,
      banReason: null,
      restrictions,
      level: 3,
      source: null,
      campaign: null,
      payer: false,
      canMessage: null,
    };
  }

  class FakeList implements PlayerListRepository {
    readonly calls: PlayerPage[] = [];
    constructor(private readonly rows: PlayerListRow[]) {}
    async page(page: PlayerPage): Promise<PlayerListRow[]> {
      this.calls.push(page);
      return this.rows;
    }
  }

  async function lists(rows: PlayerListRow[]) {
    const accounts = new MemoryAccountRepository();
    const rolesRepository = new MemoryRolesRepository();
    const repository = new FakeList(rows);
    const service = new PlayerListService(repository, new RolesService(config(), rolesRepository, accounts));
    const account = await player(accounts, "600020");
    await rolesRepository.grant(account.accountId, "moderator", null);
    const moderator: AccountRef = { accountId: account.accountId, platform: "telegram", platformUserId: "600020" };
    return { repository, service, moderator };
  }

  it("запрос «видит скрытые» идёт от права актора: владелец — да, модератор — нет", async () => {
    const l = await lists([row(1, ["separate_board"])]);
    await l.service.list(owner, playerListQuerySchema.parse({ restricted: "any" }));
    await l.service.list(l.moderator, playerListQuerySchema.parse({ restricted: "any" }));

    expect(l.repository.calls.map((page) => page.showHidden)).toEqual([true, false]);
  });

  it("виды в строке: у модератора скрытого нет, даже если репозиторий его вернул; у владельца — как есть", async () => {
    const l = await lists([row(1, ["promo_codes", "separate_board"])]);

    expect((await l.service.list(l.moderator, playerListQuerySchema.parse({}))).players[0]?.restrictions).toEqual(["promo_codes"]);
    expect((await l.service.list(owner, playerListQuerySchema.parse({}))).players[0]?.restrictions).toEqual(["promo_codes", "separate_board"]);
  });

  it("фильтр по скрытому виду: у владельца работает, у модератора — как на неизвестное значение, в базу не идёт", async () => {
    const l = await lists([row(1, ["separate_board"])]);
    await l.service.list(owner, playerListQuerySchema.parse({ restricted: "separate_board" }));
    expect(l.repository.calls).toHaveLength(1);

    const refusal = l.service.list(l.moderator, playerListQuerySchema.parse({ restricted: "separate_board" }));
    await expect(refusal).rejects.toBeInstanceOf(ValidationError);
    await expect(refusal).rejects.toThrow("Некорректные фильтры списка игроков");
    expect(l.repository.calls).toHaveLength(1);
  });
});

describe("ник игрока в панели (T-0151)", () => {
  let s: ReturnType<typeof setup>;

  beforeEach(() => {
    s = setup();
  });

  it("смена: ник чистится, закрепляется, в журнале было → стало", async () => {
    const target = await player(s.accounts);
    const result = await s.service.rename(owner, target.accountId, "Тимур", NOW);

    expect(result.account).toMatchObject({ displayName: "Тимур", nameLocked: true });
    const entry = s.rolesRepository.entries.find((candidate) => candidate.action === "players.rename");
    expect(entry).toMatchObject({ actorAccountId: owner.accountId, target: target.accountId });
    expect(entry?.before).toMatchObject({ displayName: "Путник", nameLocked: false });
    expect(entry?.after).toMatchObject({ displayName: "Тимур", nameLocked: true });
    expect((await s.accounts.byId(target.accountId))?.nameLockedAt).toEqual(NOW);
  });

  it("ник из знаков U+0489 не проходит чистку: ошибка с причиной, ник и журнал не тронуты", async () => {
    const target = await player(s.accounts);
    await expect(s.service.rename(owner, target.accountId, "\u0489\u0489\u0489", NOW)).rejects.toThrow(ValidationError);
    await expect(s.service.rename(owner, target.accountId, "\u0489\u0489\u0489", NOW)).rejects.toThrow("Ник не прошёл проверку: empty");
    expect((await s.accounts.byId(target.accountId))?.displayName).toBe("Путник");
    expect(s.rolesRepository.entries.filter((entry) => entry.action === "players.rename")).toEqual([]);
  });

  it("мат не проходит", async () => {
    const target = await player(s.accounts);
    await expect(s.service.rename(owner, target.accountId, "Абвгде хуй", NOW)).rejects.toThrow("Ник не прошёл проверку: profanity");
  });

  it("снятие закрепления возвращает ник с площадки (через чистку) и пишется в журнал", async () => {
    const target = await player(s.accounts);
    await s.service.rename(owner, target.accountId, "Тимур", NOW);
    const result = await s.service.unlockName(owner, target.accountId, NOW);

    expect(result.account).toMatchObject({ displayName: "Путник", nameLocked: false });
    expect((await s.accounts.byId(target.accountId))?.nameLockedAt).toBeNull();
    const entry = s.rolesRepository.entries.find((candidate) => candidate.action === "players.rename.unlock");
    expect(entry?.before).toMatchObject({ displayName: "Тимур", nameLocked: true });
    expect(entry?.after).toMatchObject({ displayName: "Путник", nameLocked: false });
  });

  it("исходный ник с площадки, который чистка исправила, виден в строке", async () => {
    const target = await s.accounts.upsert({ platform: "telegram", platformUserId: "500777", displayName: "  Тимур\u0489  ", username: "timur", photoUrl: null }, NOW.getTime());
    const card = await s.service.card(owner, target.accountId);
    expect(card.account.platformName).toBe("  Тимур\u0489  ");
    expect(card.account.nameLocked).toBe(false);
  });

  it("без права players.ban — 403, несуществующий аккаунт — 404; ничего не меняется", async () => {
    const marketer = await player(s.accounts, "600002");
    await s.rolesRepository.grant(marketer.accountId, "marketer", null);
    const marketerRef: AccountRef = { accountId: marketer.accountId, platform: "telegram", platformUserId: marketer.platformUserId };
    const target = await player(s.accounts);

    await expect(s.service.rename(marketerRef, target.accountId, "Тимур", NOW)).rejects.toThrow(ForbiddenError);
    await expect(s.service.unlockName(marketerRef, target.accountId, NOW)).rejects.toThrow(ForbiddenError);
    await expect(s.service.rename(owner, randomUUID(), "Тимур", NOW)).rejects.toThrow(AccountNotFoundError);
    await expect(s.service.unlockName(owner, randomUUID(), NOW)).rejects.toThrow(AccountNotFoundError);
    expect((await s.accounts.byId(target.accountId))?.displayName).toBe("Путник");
  });
});
