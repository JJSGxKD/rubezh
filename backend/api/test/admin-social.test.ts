import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { Account } from "../src/modules/auth/account.repository.js";
import { AdminSocialService } from "../src/modules/admin/admin-social.service.js";
import type { ReferralBinding, ReferralsRepository, ReferralStatus } from "../src/modules/referrals/referrals.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryFriendsRepository } from "./helpers/memory-friends.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Друзья и рефералка в карточке панели: модератор видит, кем приглашён игрок и
 * скольких привёл, и отклоняет ожидающую привязку с записью в журнал.
 */

const OWNER_ID = "777000111";

class Referrals implements Pick<ReferralsRepository, "binding" | "counts" | "reject"> {
  readonly bindings = new Map<string, ReferralBinding>();
  async binding(referredId: string): Promise<ReferralBinding | null> {
    return this.bindings.get(referredId) ?? null;
  }
  async counts(referrerId: string): Promise<Record<ReferralStatus, number>> {
    const counts = { bound: 0, activated: 0, rejected: 0 };
    for (const row of this.bindings.values()) if (row.referrerId === referrerId) counts[row.status]++;
    return counts;
  }
  async reject(referredId: string, reason: string): Promise<boolean> {
    const row = this.bindings.get(referredId);
    if (row?.status !== "bound") return false;
    this.bindings.set(referredId, { ...row, status: "rejected", rejectReason: reason });
    return true;
  }
}

let accounts: MemoryAccountRepository;
let rolesRepository: MemoryRolesRepository;
let referrals: Referrals;
let service: AdminSocialService;

async function player(id: string): Promise<Account> {
  return await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
}

const ref = (account: Account) => ({ accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId });

beforeEach(() => {
  accounts = new MemoryAccountRepository();
  rolesRepository = new MemoryRolesRepository();
  referrals = new Referrals();
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
  const roles = new RolesService(config, rolesRepository, accounts);
  service = new AdminSocialService(accounts, new MemoryFriendsRepository(accounts), referrals as unknown as ReferralsRepository, roles);
});

describe("друзья и рефералка в панели", () => {
  it("кем приглашён и скольких привёл", async () => {
    const referrer = await player("1");
    const referred = await player("2");
    referrals.bindings.set(referred.accountId, { referredId: referred.accountId, referrerId: referrer.accountId, status: "bound", boundAt: new Date(), activatedAt: null, rejectReason: null });

    expect(await service.social(referred.accountId)).toMatchObject({ friends: 0, referredBy: { referrerId: referrer.accountId, referrerName: "Игрок 1", status: "bound" } });
    expect((await service.social(referrer.accountId)).referrals).toEqual({ bound: 1, activated: 0, rejected: 0 });
    await expect(service.social("3c8f3a52-2d4e-4c55-9d0e-6f3b2a1c0d9e")).rejects.toMatchObject({ code: "account_not_found" });
  });

  it("отклонение — только с правом на блокировку, ожидающей привязки и с записью в журнал", async () => {
    const owner = await player(OWNER_ID);
    const stranger = await player("5");
    const referrer = await player("1");
    const referred = await player("2");
    referrals.bindings.set(referred.accountId, { referredId: referred.accountId, referrerId: referrer.accountId, status: "bound", boundAt: new Date(), activatedAt: null, rejectReason: null });

    await expect(service.rejectReferral(ref(stranger), referred.accountId, "ферма")).rejects.toMatchObject({ code: "forbidden" });
    expect(await service.rejectReferral(ref(owner), referred.accountId, "ферма с одного устройства")).toEqual({ rejected: true });
    expect(referrals.bindings.get(referred.accountId)?.status).toBe("rejected");
    expect(await service.rejectReferral(ref(owner), referred.accountId, "повтор")).toEqual({ rejected: false });

    const audit = await rolesRepository.recentAudit(10);
    expect(audit.filter((entry) => entry.action === "referrals.reject")).toHaveLength(1);
  });
});
