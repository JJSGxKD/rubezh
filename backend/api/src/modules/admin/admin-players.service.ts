import { Inject, Injectable } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import type { AcquisitionView, SessionsRepository } from "../attribution/sessions.repository.js";
import { SESSIONS_REPOSITORY } from "../attribution/sessions.repository.js";
import { ACCOUNT_REPOSITORY, type Account, type AccountRepository } from "../auth/account.repository.js";
import { AuthService } from "../auth/auth.service.js";
import { FUNNEL_REPOSITORY, type FunnelMilestones, type FunnelRepository } from "../funnel/funnel.repository.js";
import type { MessagingState } from "../messaging/messaging.repository.js";
import { MessagingService } from "../messaging/messaging.service.js";
import type { StoredPurchase } from "../payments/purchase-types.js";
import { PURCHASES_REPOSITORY, type PurchasesRepository } from "../payments/purchases.repository.js";
import { ProgressService, type ProgressView } from "../progress/progress.service.js";
import type { Role } from "../roles/permissions.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { RunsViewService, type ProfileView } from "../runs/runs-view.service.js";
import type { WalletEntryRow } from "../wallet/wallet.repository.js";
import { WalletService } from "../wallet/wallet.service.js";
import type { Balances } from "../wallet/wallet-types.js";
import { AccountNotFoundError } from "./admin-errors.js";
import { AdminSessionService } from "./admin-session.service.js";

/**
 * Игроки в панели (docs/29-admin-panel.md §2, §3.3): поиск, карточка,
 * блокировка. Сервис собирает карточку из чужих модулей и ничего не знает о
 * базе: у каждого раздела карточки свой владелец, и запрос к его таблицам —
 * его метод (docs/36-parallel-work.md §2).
 *
 * Персональные данные — идентификатор на площадке и юзернейм — только с правом
 * `players.pii.view`, и такой просмотр пишется в журнал. Покупки — только с
 * правом на аналитику выручки: модератор карточку видит, а платежи — нет.
 */

const WALLET_ENTRIES_SHOWN = 50;
const PURCHASES_SHOWN = 50;

export interface PlayerRow {
  accountId: string;
  platform: Account["platform"];
  displayName: string;
  photoUrl: string | null;
  createdAt: string;
  banned: { at: string; reason: string | null } | null;
  /** идентификатор на площадке и юзернейм — только с правом на персональные данные */
  pii: { platformUserId: string; username: string | null } | null;
}

export interface PlayerCard {
  account: PlayerRow;
  roles: Role[];
  funnel: FunnelMilestones | null;
  acquisition: AcquisitionView | null;
  messaging: MessagingState | null;
  progress: ProgressView;
  runs: ProfileView;
  wallet: { balances: Balances; entries: WalletEntryRow[] };
  /** `null` — права на платежи нет */
  purchases: StoredPurchase[] | null;
}

export interface BanResult {
  account: PlayerRow;
  /** сколько сессий игры и панели отозвано */
  revokedSessions: number;
}

@Injectable()
export class AdminPlayersService {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(FUNNEL_REPOSITORY) private readonly funnel: FunnelRepository,
    @Inject(SESSIONS_REPOSITORY) private readonly sessions: SessionsRepository,
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: PurchasesRepository,
    private readonly roles: RolesService,
    private readonly messaging: MessagingService,
    private readonly progress: ProgressService,
    private readonly runs: RunsViewService,
    private readonly wallet: WalletService,
    private readonly auth: AuthService,
    private readonly adminSessions: AdminSessionService,
  ) {}

  async search(actor: AccountRef, query: string, limit: number): Promise<PlayerRow[]> {
    const withPii = await this.roles.can(actor, "players.pii.view");
    const found = await this.accounts.search(query, limit);
    // Поиск по Telegram ID сам по себе — работа с персональными данными, и
    // без права на них строки уходят без идентификаторов.
    if (withPii && found.length > 0) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "players.pii.view", target: null, after: { query, found: found.length } });
    }
    return found.map((account) => rowOf(account, withPii));
  }

  async card(actor: AccountRef, accountId: string): Promise<PlayerCard> {
    const account = await this.accounts.byId(accountId);
    if (account === null) throw new AccountNotFoundError();

    const [withPii, withPayments] = await Promise.all([this.roles.can(actor, "players.pii.view"), this.roles.can(actor, "analytics.revenue.view")]);
    const target: AccountRef = { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };

    const [roles, funnel, acquisition, messaging, progress, runs, balances, entries, purchases] = await Promise.all([
      this.roles.rolesFor(target),
      this.funnel.milestones(accountId),
      this.sessions.acquisition(accountId),
      this.messaging.state(accountId),
      this.progress.view(accountId),
      this.runs.profile(accountId),
      this.wallet.balances(accountId),
      this.wallet.recentEntries(accountId, WALLET_ENTRIES_SHOWN),
      withPayments ? this.purchases.byAccount(accountId, PURCHASES_SHOWN) : Promise.resolve(null),
    ]);

    if (withPii) await this.roles.audit({ actorAccountId: actor.accountId, action: "players.pii.view", target: accountId });

    return {
      account: rowOf(account, withPii),
      roles,
      funnel,
      acquisition,
      messaging,
      progress,
      runs,
      wallet: { balances, entries },
      purchases,
    };
  }

  /**
   * Блокировка: аккаунт помечается, все его сессии — игры и панели —
   * отзываются сразу, действие уходит в журнал с прежним состоянием. Себя
   * заблокировать нельзя — иначе единственный владелец закроет панель себе.
   */
  async ban(actor: AccountRef, accountId: string, reason: string, now = new Date()): Promise<BanResult> {
    await this.roles.require(actor, "players.ban");
    if (actor.accountId === accountId) throw new ValidationError("Заблокировать себя нельзя");

    const before = await this.accounts.byId(accountId);
    if (before === null) throw new AccountNotFoundError();
    const account = await this.accounts.setBan(accountId, { at: now, reason });
    if (account === null) throw new AccountNotFoundError();

    const [game, panel] = await Promise.all([this.auth.logoutEverywhere(accountId), this.adminSessions.revokeAll(accountId)]);
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "players.ban",
      target: accountId,
      before: banState(before),
      after: banState(account),
    });
    return { account: rowOf(account, true), revokedSessions: game + panel };
  }

  async unban(actor: AccountRef, accountId: string): Promise<BanResult> {
    await this.roles.require(actor, "players.ban");

    const before = await this.accounts.byId(accountId);
    if (before === null) throw new AccountNotFoundError();
    const account = await this.accounts.setBan(accountId, null);
    if (account === null) throw new AccountNotFoundError();

    // Повтор разблокировки — не событие: журнал не растёт от двойного нажатия.
    if (before.bannedAt !== null) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "players.unban", target: accountId, before: banState(before), after: banState(account) });
    }
    return { account: rowOf(account, true), revokedSessions: 0 };
  }
}

function rowOf(account: Account, withPii: boolean): PlayerRow {
  return {
    accountId: account.accountId,
    platform: account.platform,
    displayName: account.displayName,
    photoUrl: account.photoUrl,
    createdAt: account.createdAt.toISOString(),
    banned: account.bannedAt === null ? null : { at: account.bannedAt.toISOString(), reason: account.banReason },
    pii: withPii ? { platformUserId: account.platformUserId, username: account.username } : null,
  };
}

function banState(account: Account): { bannedAt: string | null; banReason: string | null } {
  return { bannedAt: account.bannedAt?.toISOString() ?? null, banReason: account.banReason };
}
