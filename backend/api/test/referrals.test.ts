import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { parseStartParam } from "../src/modules/attribution/start-param.js";
import type { SessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import type { Account } from "../src/modules/auth/account.repository.js";
import { AuthHooks, PLAIN_LOGIN, type LoginEvent } from "../src/modules/auth/auth-hooks.js";
import { REFERRAL_RULES } from "../src/modules/referrals/referral-rules.js";
import type { ReferralBinding, ReferralRow, ReferralsRepository } from "../src/modules/referrals/referrals.repository.js";
import { ReferralsService } from "../src/modules/referrals/referrals.service.js";
import type { RunsRepository } from "../src/modules/runs/runs.repository.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryFriendsRepository } from "./helpers/memory-friends.js";

/**
 * Рефералка (docs/23-referral-and-partner-program.md §2): засчитывается
 * активация, а не регистрация; привязка одна, навсегда и только в окне;
 * самоприглашение из той же подсети не проходит; активаций в сутки — потолок.
 */

class MemoryReferrals implements ReferralsRepository {
  readonly bindings = new Map<string, ReferralBinding>();
  constructor(private readonly accounts: MemoryAccountRepository) {}
  async binding(referredId: string): Promise<ReferralBinding | null> {
    return this.bindings.get(referredId) ?? null;
  }
  async bind(referredId: string, referrerId: string, status: "bound" | "rejected", rejectReason: string | null): Promise<boolean> {
    if (this.bindings.has(referredId)) return false;
    this.bindings.set(referredId, { referredId, referrerId, status, rejectReason, boundAt: new Date(), activatedAt: null });
    return true;
  }
  async activate(referredId: string, at: Date): Promise<boolean> {
    const binding = this.bindings.get(referredId);
    if (binding?.status !== "bound") return false;
    this.bindings.set(referredId, { ...binding, status: "activated", activatedAt: at });
    return true;
  }
  async activatedToday(referrerId: string): Promise<number> {
    return [...this.bindings.values()].filter((row) => row.referrerId === referrerId && row.status === "activated").length;
  }
  async byReferrer(referrerId: string): Promise<ReferralRow[]> {
    const rows: ReferralRow[] = [];
    for (const binding of this.bindings.values()) {
      if (binding.referrerId !== referrerId || binding.status === "rejected") continue;
      const account = await this.accounts.byId(binding.referredId);
      rows.push({ ...binding, displayName: account?.displayName ?? "?", photoUrl: null });
    }
    return rows;
  }
}

class FakeWallet {
  readonly grants = new Map<string, GrantInput>();
  async grant(input: GrantInput): Promise<GrantResult> {
    const duplicate = this.grants.has(input.idempotencyKey);
    if (!duplicate) this.grants.set(input.idempotencyKey, input);
    return { credited: duplicate ? 0 : input.amount, balance: 0, duplicate };
  }
}

let accounts: MemoryAccountRepository;
let friends: MemoryFriendsRepository;
let referrals: MemoryReferrals;
let wallet: FakeWallet;
let networks: Map<string, string[]>;
let runCounts: Map<string, number>;
let service: ReferralsService;

async function player(id: string, createdMs = Date.now()): Promise<Account> {
  return await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, createdMs);
}

function login(account: Account, startParam: string, patch: Partial<LoginEvent> = {}): LoginEvent {
  return { ...PLAIN_LOGIN, ip: "198.51.100.7", accountId: account.accountId, platform: account.platform, place: "miniapp", startParam: parseStartParam(startParam), created: true, at: new Date(), ...patch };
}

function run(account: Account, patch: Partial<RecordedRun> = {}): RecordedRun {
  return {
    runId: `r-${Math.random()}`,
    accountId: account.accountId,
    difficulty: "easy",
    outcome: "died",
    survivalSec: 300,
    level: 10,
    enemiesKilled: 400,
    startingWeaponId: "spark_bolt",
    deathCause: null,
    cheats: false,
    continues: 0,
    ranked: true,
    verdict: "ok",
    reasons: [],
    finishedAt: new Date(),
    ...patch,
  };
}

async function playRuns(account: Account, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    runCounts.set(account.accountId, (runCounts.get(account.accountId) ?? 0) + 1);
    await service.onRun(run(account));
  }
}

beforeEach(() => {
  accounts = new MemoryAccountRepository();
  friends = new MemoryFriendsRepository(accounts);
  referrals = new MemoryReferrals(accounts);
  wallet = new FakeWallet();
  networks = new Map();
  runCounts = new Map();
  const sessions = { record: async () => "recorded" as const, acquisition: async () => null, recentIpPrefixes: async (id: string) => networks.get(id) ?? [] } satisfies SessionsRepository;
  const runs = { stats: async (id: string) => ({ runs: runCounts.get(id) ?? 0, totalKills: 0, totalSurvivalSec: 0 }) } as unknown as RunsRepository;
  service = new ReferralsService(
    loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv),
    referrals,
    friends,
    accounts,
    sessions,
    runs,
    wallet as unknown as WalletService,
    new AuthHooks(),
    new RunsHooks(),
  );
});

async function inviteLink(owner: Account): Promise<string> {
  return `f-${await friends.linkOf(owner.accountId)}`;
}

describe("привязка", () => {
  it("новичок по ссылке — реферал владельца и сразу получает стартовые монеты", async () => {
    const owner = await player("1");
    const newcomer = await player("2");
    await service.onLogin(login(newcomer, await inviteLink(owner)));

    expect(referrals.bindings.get(newcomer.accountId)).toMatchObject({ referrerId: owner.accountId, status: "bound" });
    expect(wallet.grants.get(`referral_welcome:${newcomer.accountId}`)).toMatchObject({ accountId: newcomer.accountId, amount: REFERRAL_RULES.welcomeCoins, reason: "referral_reward" });
  });

  it("привязка одна и навсегда: вторая ссылка её не переприсваивает", async () => {
    const first = await player("1");
    const second = await player("2");
    const newcomer = await player("3");
    await service.onLogin(login(newcomer, await inviteLink(first)));
    await service.onLogin(login(newcomer, await inviteLink(second)));
    expect(referrals.bindings.get(newcomer.accountId)?.referrerId).toBe(first.accountId);
    expect(wallet.grants.size).toBe(1);
  });

  it("старый игрок по чужой ссылке приведённым не считается; своя ссылка и повторный вход — тоже", async () => {
    const owner = await player("1");
    const veteran = await player("2", Date.now() - (REFERRAL_RULES.bindWindowDays + 1) * 86_400_000);
    await service.onLogin(login(veteran, await inviteLink(owner)));
    await service.onLogin(login(owner, await inviteLink(owner)));
    const newcomer = await player("3");
    await service.onLogin(login(newcomer, await inviteLink(owner), { reason: "reauth" }));
    expect(referrals.bindings.size).toBe(0);
  });

  it("самоприглашение из той же подсети — привязка отклонена, никто ничего не получает", async () => {
    const owner = await player("1");
    networks.set(owner.accountId, ["198.51.100.0/24"]);
    const twin = await player("2");
    await service.onLogin(login(twin, await inviteLink(owner)));

    expect(referrals.bindings.get(twin.accountId)).toMatchObject({ status: "rejected", rejectReason: "same_network" });
    expect(wallet.grants.size).toBe(0);
    await playRuns(twin, REFERRAL_RULES.activationRuns);
    expect(wallet.grants.size).toBe(0);
  });
});

describe("активация", () => {
  it("засчитывается после нужного числа забегов, награда пригласившему — один раз", async () => {
    const owner = await player("1");
    const newcomer = await player("2");
    await service.onLogin(login(newcomer, await inviteLink(owner)));

    await playRuns(newcomer, REFERRAL_RULES.activationRuns - 1);
    expect(referrals.bindings.get(newcomer.accountId)?.status).toBe("bound");
    await playRuns(newcomer, 2);
    expect(referrals.bindings.get(newcomer.accountId)?.status).toBe("activated");
    expect(wallet.grants.get(`referral:${newcomer.accountId}`)).toMatchObject({ accountId: owner.accountId, amount: REFERRAL_RULES.referrerCoins });
    expect([...wallet.grants.keys()].filter((key) => key.startsWith("referral:"))).toHaveLength(1);
    expect((await service.mine(owner.accountId)).activated).toBe(1);
  });

  it("забег с читами или отклонённый не продвигает активацию", async () => {
    const owner = await player("1");
    const newcomer = await player("2");
    await service.onLogin(login(newcomer, await inviteLink(owner)));
    runCounts.set(newcomer.accountId, REFERRAL_RULES.activationRuns);
    await service.onRun(run(newcomer, { cheats: true }));
    await service.onRun(run(newcomer, { verdict: "rejected" }));
    expect(referrals.bindings.get(newcomer.accountId)?.status).toBe("bound");
  });

  it("сверх потолка активаций в сутки ждёт следующего забега, а не пропадает", async () => {
    const owner = await player("owner");
    const link = await inviteLink(owner);
    const invited: Account[] = [];
    for (let index = 0; index <= REFERRAL_RULES.maxActivationsPerDay; index++) {
      const newcomer = await player(`n${index}`);
      await service.onLogin(login(newcomer, link, { ip: `203.0.${index}.1` }));
      invited.push(newcomer);
    }
    for (const newcomer of invited) await playRuns(newcomer, REFERRAL_RULES.activationRuns);
    const late = invited[invited.length - 1] as Account;
    expect(referrals.bindings.get(late.accountId)?.status).toBe("bound");
    expect(await referrals.activatedToday(owner.accountId)).toBe(REFERRAL_RULES.maxActivationsPerDay);
  });
});
