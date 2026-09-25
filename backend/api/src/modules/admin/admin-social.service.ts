import { Inject, Injectable } from "@nestjs/common";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { FRIENDS_REPOSITORY, type FriendsRepository } from "../friends/friends.repository.js";
import { REFERRALS_REPOSITORY, type ReferralBinding, type ReferralsRepository, type ReferralStatus } from "../referrals/referrals.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { AccountNotFoundError } from "./admin-errors.js";

/**
 * Друзья и рефералка в карточке игрока (docs/29-admin-panel.md §2, «Игроки»):
 * сколько друзей, кем приглашён и скольких привёл. Отдельно от карточки —
 * её собирает `AdminPlayersService`, а этот раздел нужен модератору, который
 * разбирает накрутку (docs/23-referral-and-partner-program.md §2.4).
 */

export interface SocialView {
  friends: number;
  /** кем приглашён; `null` — пришёл сам */
  referredBy: (ReferralBinding & { referrerName: string | null }) | null;
  referrals: Record<ReferralStatus, number>;
}

@Injectable()
export class AdminSocialService {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(FRIENDS_REPOSITORY) private readonly friends: FriendsRepository,
    @Inject(REFERRALS_REPOSITORY) private readonly referrals: ReferralsRepository,
    private readonly roles: RolesService,
  ) {}

  async social(accountId: string): Promise<SocialView> {
    if ((await this.accounts.byId(accountId)) === null) throw new AccountNotFoundError();
    const [friends, binding, referrals] = await Promise.all([this.friends.count(accountId), this.referrals.binding(accountId), this.referrals.counts(accountId)]);
    const referrer = binding === null ? null : await this.accounts.byId(binding.referrerId);
    return { friends, referredBy: binding === null ? null : { ...binding, referrerName: referrer?.displayName ?? null }, referrals };
  }

  /**
   * Отклонить привязку игрока, пока она не активирована: награда пригласившему
   * не начислится. Право — то же, что на блокировку: это решение модератора о
   * накрутке. В журнал — причина и прежний статус.
   */
  async rejectReferral(actor: AccountRef, accountId: string, reason: string): Promise<{ rejected: boolean }> {
    await this.roles.require(actor, "players.ban");
    const before = await this.referrals.binding(accountId);
    const rejected = await this.referrals.reject(accountId, "moderator");
    if (rejected) {
      await this.roles.audit({
        actorAccountId: actor.accountId,
        action: "referrals.reject",
        target: accountId,
        before: { status: before?.status ?? null, referrerId: before?.referrerId ?? null },
        after: { status: "rejected", reason },
      });
    }
    return { rejected };
  }
}
