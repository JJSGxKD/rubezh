import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { parseStartParam } from "../src/modules/attribution/start-param.js";
import type { SessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import type { Account } from "../src/modules/auth/account.repository.js";
import { AuthHooks, PLAIN_LOGIN, type LoginEvent } from "../src/modules/auth/auth-hooks.js";
import type { FriendReturnsRepository, PendingReturn } from "../src/modules/referrals/friend-returns.repository.js";
import { REFERRAL_RULES, RETURN_RULES } from "../src/modules/referrals/referral-rules.js";
import type { ReferralBinding, ReferralRow, ReferralsRepository } from "../src/modules/referrals/referrals.repository.js";
import { ReferralsService } from "../src/modules/referrals/referrals.service.js";
import type { RunsRepository } from "../src/modules/runs/runs.repository.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryFriendsRepository } from "./helpers/memory-friends.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";

/**
 * Рефералка (docs/23-referral-and-partner-program.md §2): засчитывается
 * активация, а не регистрация; привязка одна, навсегда и только в окне;
 * самоприглашение из той же подсети не проходит; активаций в сутки — потолок.
 */

class MemoryReferrals implements ReferralsRepository {
  readonly bindings = new Map<string, ReferralBinding>();
  /** Сколько ближайших вызовов `activate` упадёт — как сбой базы. */
  failActivate = 0;
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
    if (this.failActivate > 0) {
      this.failActivate--;
      throw new Error("база недоступна");
    }
    const binding = this.bindings.get(referredId);
    if (binding?.status !== "bound") return false;
    this.bindings.set(referredId, { ...binding, status: "activated", activatedAt: at });
    return true;
  }
  async activatedToday(referrerId: string): Promise<number> {
    return [...this.bindings.values()].filter((row) => row.referrerId === referrerId && row.status === "activated").length;
  }
  async counts(referrerId: string): Promise<Record<"bound" | "activated" | "rejected", number>> {
    const counts = { bound: 0, activated: 0, rejected: 0 };
    for (const row of this.bindings.values()) if (row.referrerId === referrerId) counts[row.status]++;
    return counts;
  }
  async reject(referredId: string, reason: string): Promise<boolean> {
    const binding = this.bindings.get(referredId);
    if (binding?.status !== "bound") return false;
    this.bindings.set(referredId, { ...binding, status: "rejected", rejectReason: reason });
    return true;
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

class MemoryReturns implements FriendReturnsRepository {
  readonly rows = new Map<string, { returnedAt: Date; rewardedAt: Date | null }>();
  async record(returnedId: string, friendId: string, period: number, at: Date): Promise<boolean> {
    const key = `${returnedId}|${friendId}|${period}`;
    if (this.rows.has(key)) return false;
    this.rows.set(key, { returnedAt: at, rewardedAt: null });
    return true;
  }
  async pending(returnedId: string, since: Date): Promise<PendingReturn[]> {
    return [...this.rows]
      .filter(([key, row]) => key.startsWith(`${returnedId}|`) && row.rewardedAt === null && row.returnedAt >= since)
      .map(([key]) => ({ friendId: key.split("|")[1] ?? "", period: Number(key.split("|")[2]) }));
  }
  async markRewarded(returnedId: string, friendId: string, period: number, at: Date): Promise<boolean> {
    const row = this.rows.get(`${returnedId}|${friendId}|${period}`);
    if (row === undefined || row.rewardedAt !== null) return false;
    row.rewardedAt = at;
    return true;
  }
}

class FakeWallet {
  readonly grants = new Map<string, GrantInput>();
  calls = 0;
  /** Номера вызовов `grant` (с 1), которые упадут. */
  readonly failCalls = new Set<number>();
  async grant(input: GrantInput): Promise<GrantResult> {
    this.calls++;
    if (this.failCalls.has(this.calls)) throw new Error("кошелёк недоступен");
    const duplicate = this.grants.has(input.idempotencyKey);
    if (!duplicate) this.grants.set(input.idempotencyKey, input);
    return { credited: duplicate ? 0 : input.amount, balance: 0, duplicate };
  }
}

let accounts: MemoryAccountRepository;
let friends: MemoryFriendsRepository;
let referrals: MemoryReferrals;
let wallet: FakeWallet;
let restrictions: MemoryRestrictionsRepository;
let networks: Map<string, string[]>;
let runCounts: Map<string, number>;
let lastSessions: Map<string, Date>;
let returns: MemoryReturns;
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
  lastSessions = new Map();
  returns = new MemoryReturns();
  restrictions = new MemoryRestrictionsRepository();
  const sessions = {
    record: async () => "recorded" as const,
    acquisition: async () => null,
    recentIpPrefixes: async (id: string) => networks.get(id) ?? [],
    lastSessionBefore: async (id: string) => lastSessions.get(id) ?? null,
  } satisfies SessionsRepository;
  const runs = { stats: async (id: string) => ({ runs: runCounts.get(id) ?? 0, totalKills: 0, totalSurvivalSec: 0 }) } as unknown as RunsRepository;
  service = new ReferralsService(
    loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv),
    referrals,
    returns,
    friends,
    accounts,
    sessions,
    runs,
    wallet as unknown as WalletService,
    new AuthHooks(),
    new RunsHooks(),
    restrictionsGate(restrictions),
  );
});

/** События, записанные сервисом в лог, по именам. */
function loggedEvents(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => (JSON.parse(String(call[0])) as { event: string }).event);
}

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

  it("привязка, отклонённая модератором до активации, награды пригласившему не даёт", async () => {
    const owner = await player("1");
    const newcomer = await player("2");
    await service.onLogin(login(newcomer, await inviteLink(owner)));
    expect(await referrals.reject(newcomer.accountId, "moderator")).toBe(true);
    await playRuns(newcomer, REFERRAL_RULES.activationRuns);
    expect(wallet.grants.has(`referral:${newcomer.accountId}`)).toBe(false);
    expect(await referrals.counts(owner.accountId)).toEqual({ bound: 0, activated: 0, rejected: 1 });
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

describe("возвращение", () => {
  const DAY = 86_400_000;

  async function veteran(id: string, absentDays: number): Promise<Account> {
    const account = await player(id, Date.now() - 400 * DAY);
    lastSessions.set(account.accountId, new Date(Date.now() - absentDays * DAY));
    return account;
  }

  it("ушедший открыл ссылку друга и сыграл — монеты обоим, один раз", async () => {
    const friend = await player("friend");
    const gone = await veteran("gone", RETURN_RULES.absenceDays + 1);
    await service.onLogin(login(gone, await inviteLink(friend), { created: false }));
    expect(returns.rows.size).toBe(1);
    expect(wallet.grants.size).toBe(0);

    await service.onRun(run(gone));
    const grants = [...wallet.grants.values()];
    expect(grants.map((grant) => grant.accountId).sort()).toEqual([friend.accountId, gone.accountId].sort());
    expect(grants.every((grant) => grant.amount === RETURN_RULES.coins && grant.reason === "referral_reward")).toBe(true);

    await service.onRun(run(gone));
    expect(wallet.grants.size).toBe(2);
  });

  it("недолгое отсутствие, новый аккаунт и забег с читами — не возвращение", async () => {
    const friend = await player("friend");
    const recent = await veteran("recent", RETURN_RULES.absenceDays - 1);
    await service.onLogin(login(recent, await inviteLink(friend), { created: false }));
    const newcomer = await player("new");
    await service.onLogin(login(newcomer, await inviteLink(friend)));
    expect(returns.rows.size).toBe(0);

    const gone = await veteran("gone", 60);
    await service.onLogin(login(gone, await inviteLink(friend), { created: false }));
    await service.onRun(run(gone, { cheats: true }));
    expect([...wallet.grants.keys()].some((key) => key.startsWith("friend_return:"))).toBe(false);
  });

  it("пара — не чаще раза в период: второе возвращение того же периода не отмечается", async () => {
    const friend = await player("friend");
    const gone = await veteran("gone", 40);
    const link = await inviteLink(friend);
    await service.onLogin(login(gone, link, { created: false }));
    await service.onRun(run(gone));
    await service.onLogin(login(gone, link, { created: false }));
    await service.onRun(run(gone));
    expect([...wallet.grants.keys()].filter((key) => key.startsWith("friend_return:"))).toHaveLength(2);
  });
});

describe("ограничение наград за друзей (WP44)", () => {
  const DAY = 86_400_000;

  it("активация засчитана, а пригласившему с ограничением награда не приходит — ни сейчас, ни после снятия", async () => {
    const owner = await player("1");
    const newcomer = await player("2");
    await service.onLogin(login(newcomer, await inviteLink(owner)));
    const restriction = restrictions.restrict(owner.accountId, "referral_rewards", { notify: false });

    await playRuns(newcomer, REFERRAL_RULES.activationRuns);
    expect(referrals.bindings.get(newcomer.accountId)?.status).toBe("activated");
    expect(wallet.grants.has(`referral:${newcomer.accountId}`)).toBe(false);

    // Ограничение сняли — пропущенное не догоняет: иначе это была бы отсрочка.
    restriction.liftedAt = new Date();
    restriction.liftComment = "срок вышел";
    await service.onRun(run(newcomer));
    expect(wallet.grants.has(`referral:${newcomer.accountId}`)).toBe(false);
  });

  it("возвращение: ограниченная сторона без монет, вторая — с монетами; блокировка целиком закрывает так же", async () => {
    const friend = await player("friend");
    const gone = await player("gone", Date.now() - 400 * DAY);
    lastSessions.set(gone.accountId, new Date(Date.now() - (RETURN_RULES.absenceDays + 1) * DAY));
    await service.onLogin(login(gone, await inviteLink(friend), { created: false }));
    restrictions.restrict(friend.accountId, "all");

    await service.onRun(run(gone));
    expect([...wallet.grants.values()].map((grant) => grant.accountId)).toEqual([gone.accountId]);
    await service.onRun(run(gone));
    expect(wallet.grants.size).toBe(1);
  });
});

describe("сбой начисления не теряет награду", () => {
  const DAY = 86_400_000;
  let log: { mock: { calls: unknown[][] } };

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  async function invited(): Promise<{ owner: Account; newcomer: Account }> {
    const owner = await player("1");
    const newcomer = await player("2");
    await service.onLogin(login(newcomer, await inviteLink(owner)));
    runCounts.set(newcomer.accountId, REFERRAL_RULES.activationRuns - 1);
    return { owner, newcomer };
  }

  const referralGrants = (): string[] => [...wallet.grants.keys()].filter((key) => key.startsWith("referral:"));

  it("активация: начисление упало — привязка остаётся bound, следующий забег начисляет один раз", async () => {
    const { newcomer } = await invited();
    wallet.failCalls.add(wallet.calls + 1);
    runCounts.set(newcomer.accountId, REFERRAL_RULES.activationRuns);

    await expect(service.onRun(run(newcomer))).rejects.toThrow("кошелёк недоступен");
    expect(referrals.bindings.get(newcomer.accountId)?.status).toBe("bound");
    expect(loggedEvents(log)).not.toContain("referral_activated");

    await service.onRun(run(newcomer));
    expect(referrals.bindings.get(newcomer.accountId)?.status).toBe("activated");
    expect(referralGrants()).toEqual([`referral:${newcomer.accountId}`]);
    expect(loggedEvents(log)).toContain("referral_activated");
  });

  it("активация: отметка упала после начисления — следующий забег отмечает, монеты не удваиваются", async () => {
    const { owner, newcomer } = await invited();
    referrals.failActivate = 1;
    runCounts.set(newcomer.accountId, REFERRAL_RULES.activationRuns);

    await expect(service.onRun(run(newcomer))).rejects.toThrow("база недоступна");
    expect(referralGrants()).toHaveLength(1);
    expect(referrals.bindings.get(newcomer.accountId)?.status).toBe("bound");

    await service.onRun(run(newcomer));
    expect(referrals.bindings.get(newcomer.accountId)?.status).toBe("activated");
    expect(referralGrants()).toHaveLength(1);
    expect(wallet.grants.get(`referral:${newcomer.accountId}`)).toMatchObject({ accountId: owner.accountId, amount: REFERRAL_RULES.referrerCoins });
  });

  it("активация: два параллельных засчитанных забега — монеты один раз, привязка activated", async () => {
    const { newcomer } = await invited();
    runCounts.set(newcomer.accountId, REFERRAL_RULES.activationRuns);

    await Promise.all([service.onRun(run(newcomer)), service.onRun(run(newcomer))]);

    expect(referrals.bindings.get(newcomer.accountId)?.status).toBe("activated");
    expect(referralGrants()).toHaveLength(1);
    expect(loggedEvents(log).filter((event) => event === "referral_activated")).toHaveLength(1);
  });

  it("возвращение: начисление второй стороне упало — возвращение не отмечено, следующий забег доначисляет", async () => {
    const friend = await player("friend");
    const gone = await player("gone", Date.now() - 400 * DAY);
    lastSessions.set(gone.accountId, new Date(Date.now() - (RETURN_RULES.absenceDays + 1) * DAY));
    await service.onLogin(login(gone, await inviteLink(friend), { created: false }));
    const markRewarded = vi.spyOn(returns, "markRewarded");
    wallet.failCalls.add(wallet.calls + 2);

    await expect(service.onRun(run(gone))).rejects.toThrow("кошелёк недоступен");
    expect(markRewarded).not.toHaveBeenCalled();
    expect([...wallet.grants.values()].map((grant) => grant.accountId)).toEqual([gone.accountId]);
    expect(loggedEvents(log)).not.toContain("player_return_rewarded");

    await service.onRun(run(gone));
    expect([...wallet.grants.values()].map((grant) => grant.accountId).sort()).toEqual([friend.accountId, gone.accountId].sort());
    expect(markRewarded).toHaveBeenCalledTimes(1);
    expect(loggedEvents(log)).toContain("player_return_rewarded");

    await service.onRun(run(gone));
    expect(wallet.grants.size).toBe(2);
  });
});
