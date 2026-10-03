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
  const service = new AdminPlayersService(accounts, new FakeFunnel(), sessions, purchases, roles, messaging, progress, runs, wallet, auth, adminSessions, notifications.service, testNotice, restrictions);
  return { accounts, rolesRepository, purchases, store, roles, service, gameSessionsRevoked, feed: notifications.repository, restrictionsRepository };
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
