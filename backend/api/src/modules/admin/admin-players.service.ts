import { Inject, Injectable } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import type { AcquisitionView, SessionsRepository } from "../attribution/sessions.repository.js";
import { SESSIONS_REPOSITORY } from "../attribution/sessions.repository.js";
import { ACCOUNT_REPOSITORY, type Account, type AccountRepository } from "../auth/account.repository.js";
import { AuthService } from "../auth/auth.service.js";
import { FUNNEL_REPOSITORY, type FunnelMilestones, type FunnelRepository } from "../funnel/funnel.repository.js";
import type { MessagingState } from "../messaging/messaging.repository.js";
import { MessagingService } from "../messaging/messaging.service.js";
import type { TestNoticeAcceptance } from "../test-notice/test-notice.repository.js";
import { TestNoticeService } from "../test-notice/test-notice.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import type { StoredPurchase } from "../payments/purchase-types.js";
import { PURCHASES_REPOSITORY, type PurchasesRepository } from "../payments/purchases.repository.js";
import { ProgressService, type ProgressView } from "../progress/progress.service.js";
import type { ImposeInput, RestrictionView } from "../restrictions/restriction-rules.js";
import { RestrictionsService } from "../restrictions/restrictions.service.js";
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
 * блокировка, сообщение команды. Сервис собирает карточку из чужих модулей и ничего не знает о
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
  /** предупреждение об открытом тесте (WP33); `null` — не принимал */
  testNotice: TestNoticeAcceptance | null;
}

export interface BanResult {
  account: PlayerRow;
  /** сколько сессий игры и панели отозвано */
  revokedSessions: number;
}

export interface RestrictResult {
  restrictions: RestrictionView[];
  /** сколько сессий игры и панели отозвано — только у блокировки целиком */
  revokedSessions: number;
}

export interface MessageResult {
  /** это сообщение уже отправлено той же кнопкой — второй строки в ленте нет */
  duplicate: boolean;
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
    private readonly notifications: NotificationsService,
    private readonly testNotice: TestNoticeService,
    private readonly restrictions: RestrictionsService,
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

    const [roles, funnel, acquisition, messaging, progress, runs, balances, entries, purchases, testNotice] = await Promise.all([
      this.roles.rolesFor(target),
      this.funnel.milestones(accountId),
      this.sessions.acquisition(accountId),
      this.messaging.state(accountId),
      this.progress.view(accountId),
      this.runs.profile(accountId),
      this.wallet.balances(accountId),
      this.wallet.recentEntries(accountId, WALLET_ENTRIES_SHOWN),
      withPayments ? this.purchases.byAccount(accountId, PURCHASES_SHOWN) : Promise.resolve(null),
      this.testNotice.acceptance(accountId),
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
      testNotice,
    };
  }

  /**
   * Ограничить игрока (docs/35-stage4-plan.md Р75, WP44): виды, срок,
   * причина. Блокировка целиком вдобавок сразу отзывает все сессии игры и
   * панели: отметка в аккаунте закрывает только новый вход.
   */
  async restrict(actor: AccountRef, accountId: string, input: ImposeInput, now = new Date()): Promise<RestrictResult> {
    if (actor.accountId === accountId) throw new ValidationError("Ограничить себя нельзя");
    if ((await this.accounts.byId(accountId)) === null) throw new AccountNotFoundError();
    const restrictions = await this.restrictions.impose(actor, accountId, input, now);
    if (!input.kinds.includes("all")) return { restrictions, revokedSessions: 0 };
    const [game, panel] = await Promise.all([this.auth.logoutEverywhere(accountId), this.adminSessions.revokeAll(accountId)]);
    return { restrictions, revokedSessions: game + panel };
  }

  /**
   * Прежняя кнопка «Заблокировать» — бессрочная блокировка целиком: текст
   * модератора уходит комментарием, игрок видит причину шаблона «другое».
   * Себя заблокировать нельзя — иначе единственный владелец закроет панель себе.
   */
  async ban(actor: AccountRef, accountId: string, reason: string, now = new Date()): Promise<BanResult> {
    const { revokedSessions } = await this.restrict(actor, accountId, { kinds: ["all"], endsAt: null, reason: "other", comment: reason, notify: true }, now);
    return { account: await this.row(accountId), revokedSessions };
  }

  /** Снять блокировку — все действующие блокировки целиком; повтор — тихо, журнал не растёт. */
  async unban(actor: AccountRef, accountId: string, now = new Date()): Promise<BanResult> {
    await this.roles.require(actor, "players.ban");
    if ((await this.accounts.byId(accountId)) === null) throw new AccountNotFoundError();
    await this.restrictions.liftKind(actor, accountId, "all", "Блокировка снята в карточке игрока", now);
    return { account: await this.row(accountId), revokedSessions: 0 };
  }

  private async row(accountId: string): Promise<PlayerRow> {
    const account = await this.accounts.byId(accountId);
    if (account === null) throw new AccountNotFoundError();
    return rowOf(account, true);
  }

  /**
   * Сообщение команды в ленту игрока (docs/35-stage4-plan.md Р51). Ключ
   * задаёт кнопка панели: повтор после обрыва сети ни второй строки в ленте,
   * ни второй записи в журнале не заводит. Текст уходит в журнал целиком —
   * это слова команды, а не данные игрока.
   */
  async message(actor: AccountRef, accountId: string, text: string, idempotencyKey: string, now = new Date()): Promise<MessageResult> {
    await this.roles.require(actor, "players.message");
    if ((await this.accounts.byId(accountId)) === null) throw new AccountNotFoundError();

    const created = await this.notifications.deliver({ accountId, kind: "team_message", payload: { text }, dedupeKey: `team:${idempotencyKey}`, at: now });
    if (created) await this.roles.audit({ actorAccountId: actor.accountId, action: "players.message", target: accountId, after: { text } });
    return { duplicate: !created };
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

