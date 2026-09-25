import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ValidationError } from "../../common/domain-error.js";
import type { AccessTokenClaims } from "../auth/access-token.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { AuthHooks, type LoginEvent } from "../auth/auth-hooks.js";
import { friendStartParam } from "./friend-code.js";
import { FriendLimitError, FriendNotFoundError, FriendRequestNotFoundError } from "./friends-errors.js";
import { FRIENDS_RULES } from "./friends-rules.js";
import { FRIENDS_REPOSITORY, type FriendRow, type FriendsRepository, type RequestRow } from "./friends.repository.js";

/**
 * Друзья (docs/35-stage4-plan.md §3.8, WP14): ссылка дружбы, заявки, граф.
 *
 * Дружба взаимна и живёт внутри площадки: игрок с другой площадки для раздела
 * друзей не существует, как и заблокированный. Встречная заявка — уже
 * согласие: двое позвали друг друга, спрашивать ещё раз незачем.
 *
 * Событий аналитики модуль не шлёт: дружбу порождает сервер, а конверт
 * события привязан к устройству (docs/22-analytics-and-metrics.md §3.3, тот же
 * случай, что вехи воронки). Данные — строки `friendship` с источником и
 * временем.
 */

export interface FriendsView {
  friends: FriendRow[];
  incoming: RequestRow[];
  outgoing: RequestRow[];
  limits: { maxFriends: number };
}

export type RequestResult = { status: "requested" } | { status: "friends" };

@Injectable()
export class FriendsService implements OnModuleInit {
  private readonly logger = new Logger("friends");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FRIENDS_REPOSITORY) private readonly friends: FriendsRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly hooks: AuthHooks,
  ) {}

  onModuleInit(): void {
    if (this.config.auth.enabled) this.hooks.onLogin("friends", (login) => this.onLogin(login));
  }

  async view(accountId: string): Promise<FriendsView> {
    const [friends, incoming, outgoing] = await Promise.all([
      this.friends.friends(accountId, FRIENDS_RULES.maxFriends),
      this.friends.incoming(accountId, FRIENDS_RULES.maxIncomingRequests),
      this.friends.outgoing(accountId, FRIENDS_RULES.maxOutgoingRequests),
    ]);
    return { friends, incoming, outgoing, limits: { maxFriends: FRIENDS_RULES.maxFriends } };
  }

  async link(accountId: string): Promise<{ code: string; startParam: string }> {
    const code = await this.friends.linkOf(accountId);
    return { code, startParam: friendStartParam(code) };
  }

  async request(actor: AccessTokenClaims, targetId: string): Promise<RequestResult> {
    if (targetId === actor.accountId) throw new ValidationError("Позвать в друзья самого себя нельзя");
    await this.peer(actor, targetId);
    if (await this.friends.areFriends(actor.accountId, targetId)) return { status: "friends" };
    if (await this.friends.hasRequest(targetId, actor.accountId)) return await this.accept(actor, targetId);

    const outcome = await this.friends.request(actor.accountId, targetId, {
      maxIncoming: FRIENDS_RULES.maxIncomingRequests,
      maxOutgoing: FRIENDS_RULES.maxOutgoingRequests,
    });
    if (outcome === "incoming_full") throw new FriendLimitError("У игрока слишком много заявок — попробуйте позже");
    if (outcome === "outgoing_full") throw new FriendLimitError("Слишком много заявок ждут ответа — отмените часть");
    return { status: "requested" };
  }

  async accept(actor: AccessTokenClaims, fromId: string): Promise<{ status: "friends" }> {
    if (!(await this.friends.hasRequest(fromId, actor.accountId))) throw new FriendRequestNotFoundError();
    const result = await this.friends.befriend(fromId, actor.accountId, "request", FRIENDS_RULES.maxFriends);
    if (result.outcome === "limit") {
      throw new FriendLimitError(
        result.accountId === actor.accountId ? `У вас уже ${FRIENDS_RULES.maxFriends} друзей — это потолок` : "У игрока уже потолок друзей",
      );
    }
    if (result.outcome === "added") this.log("friend_added", { accountId: actor.accountId, friendId: fromId, source: "request" });
    return { status: "friends" };
  }

  async decline(actor: AccessTokenClaims, fromId: string): Promise<{ declined: boolean }> {
    return { declined: await this.friends.dropRequest(fromId, actor.accountId) };
  }

  async cancel(actor: AccessTokenClaims, toId: string): Promise<{ cancelled: boolean }> {
    return { cancelled: await this.friends.dropRequest(actor.accountId, toId) };
  }

  async remove(actor: AccessTokenClaims, friendId: string): Promise<{ removed: boolean }> {
    return { removed: await this.friends.remove(actor.accountId, friendId) };
  }

  /**
   * Ссылка дружбы: открыл — стал другом владельца, без лишних действий
   * (критерий приёмки WP14). Повторный вход посреди работы — та же сессия.
   * Своя ссылка, чужая площадка, заблокированный владелец и потолок — просто
   * не дружба: вход игрока от этого не зависит.
   */
  async onLogin(login: LoginEvent): Promise<void> {
    const { startParam } = login;
    if (startParam.kind !== "friend" || startParam.ref === null || login.reason !== "launch") return;
    const ownerId = await this.friends.ownerOf(startParam.ref);
    if (ownerId === null || ownerId === login.accountId) return;
    const owner = await this.accounts.byId(ownerId);
    if (owner === null || owner.bannedAt !== null || owner.platform !== login.platform) return;

    const result = await this.friends.befriend(ownerId, login.accountId, "link", FRIENDS_RULES.maxFriends);
    if (result.outcome === "added") this.log("friend_added", { accountId: login.accountId, friendId: ownerId, source: "link", created: login.created });
    if (result.outcome === "limit") this.log("friend_link_over_limit", { accountId: login.accountId, friendId: ownerId });
  }

  /** Другой игрок — существует, не заблокирован и на той же площадке. */
  private async peer(actor: AccessTokenClaims, accountId: string): Promise<void> {
    const account = await this.accounts.byId(accountId);
    if (account === null || account.bannedAt !== null || account.platform !== actor.platform) throw new FriendNotFoundError();
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "friends", event, ...fields }));
  }
}
