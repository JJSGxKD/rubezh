import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitedError } from "../src/common/domain-error.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import type { BestRunRow } from "../src/modules/runs/runs.repository.js";
import { CompensationController } from "../src/modules/wipe/compensation.controller.js";
import type { CompensationRepository, CompensationRow } from "../src/modules/wipe/compensation.repository.js";
import { CompensationNotFoundError, CompensationService, type CompensationView } from "../src/modules/wipe/compensation.service.js";
import type { RateLimit } from "../src/modules/ingest/rate-limiter.js";
import type { WalletService } from "../src/modules/wallet/wallet.service.js";
import { emptyBalances, type Balances, type GrantReason, type WalletResource } from "../src/modules/wallet/wallet-types.js";

/**
 * Выдача компенсации после вайпа (docs/35-stage4-plan.md, Р87, tasks/T-0042).
 * Сервис проверяется на подменах репозитория и кошелька; кошелёк настоящий —
 * в `compensation.integration.test.ts`. Здесь закрепляется порядок («сначала
 * начисления, потом отметка»), ключи и безопасность повтора после сбоя.
 */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const NOW = new Date(Date.UTC(2026, 9, 20, 12));

interface GrantCall {
  accountId: string;
  resource: WalletResource;
  amount: number;
  reason: GrantReason;
  source?: string | null;
  idempotencyKey: string;
}

/** Хронология вызовов: по ней проверяется порядок «начисления — потом отметка». */
type Journal = string[];

class MemoryCompensation implements CompensationRepository {
  readonly rows = new Map<string, CompensationRow>();
  readonly marks: { accountId: string; at: Date }[] = [];

  constructor(private readonly journal: Journal) {}

  async find(accountId: string): Promise<CompensationRow | null> {
    const row = this.rows.get(accountId);
    return row === undefined ? null : { ...row };
  }

  async markClaimed(accountId: string, at: Date): Promise<boolean> {
    const row = this.rows.get(accountId);
    if (row === undefined || row.claimedAt !== null) return false;
    row.claimedAt = at;
    this.marks.push({ accountId, at });
    this.journal.push("markClaimed");
    return true;
  }
}

/** Кошелёк с идемпотентностью по ключу, как настоящий: повтор с тем же ключом ничего не начисляет. */
class FakeWallet {
  readonly calls: GrantCall[] = [];
  readonly entries = new Map<string, GrantCall>();
  /** номер вызова (с единицы), на котором кошелёк бросает один раз */
  failOnCall: number | null = null;
  private count = 0;

  constructor(private readonly journal: Journal) {}

  async grant(input: GrantCall): Promise<{ credited: number; balance: number; duplicate: boolean }> {
    this.count += 1;
    this.calls.push(input);
    this.journal.push(`grant:${input.idempotencyKey}`);
    if (this.failOnCall === this.count) {
      this.failOnCall = null;
      throw new Error("кошелёк недоступен");
    }
    const known = this.entries.get(input.idempotencyKey);
    if (known !== undefined) return { credited: known.amount, balance: this.gems(), duplicate: true };
    this.entries.set(input.idempotencyKey, input);
    return { credited: input.amount, balance: this.gems(), duplicate: false };
  }

  async balances(): Promise<Balances> {
    return { ...emptyBalances(), gems: this.gems() };
  }

  gems(): number {
    return [...this.entries.values()].filter((entry) => entry.resource === "gems").reduce((sum, entry) => sum + entry.amount, 0);
  }
}

function rowOf(patch: Partial<CompensationRow> = {}): CompensationRow {
  return {
    accountId: ACCOUNT,
    tester: true,
    level: 12,
    bonusGems: 60,
    grants: [
      { purchaseId: P1, resource: "gems", amount: 150 },
      { purchaseId: P2, resource: "gems", amount: 60 },
    ],
    continueStars: 0,
    claimedAt: null,
    ...patch,
  };
}

function setup(row: CompensationRow | null = rowOf()) {
  const journal: Journal = [];
  const repository = new MemoryCompensation(journal);
  if (row !== null) repository.rows.set(row.accountId, row);
  const wallet = new FakeWallet(journal);
  const service = new CompensationService(repository, wallet as unknown as WalletService);
  return { journal, repository, wallet, service };
}

describe("что положено (pending)", () => {
  it("строки нет — null", async () => {
    const { service } = setup(null);

    expect(await service.pending(ACCOUNT)).toBeNull();
  });

  it("уже забрано — null", async () => {
    const { service } = setup(rowOf({ claimedAt: NOW }));

    expect(await service.pending(ACCOUNT)).toBeNull();
  });

  it("есть — уровень, бонус и вернувшееся из купленного суммой по ресурсу: 150 и 60 самоцветов — 210", async () => {
    const { service } = setup(rowOf({ continueStars: 10 }));

    expect(await service.pending(ACCOUNT)).toEqual({
      tester: true,
      level: 12,
      bonusGems: 60,
      restored: [{ resource: "gems", amount: 210 }],
      continueGems: 12,
    });
  });

  it("ресурсы идут в порядке WALLET_RESOURCES, а не в порядке выдач", async () => {
    const { service } = setup(
      rowOf({
        grants: [
          { purchaseId: P1, resource: "shard_rare", amount: 5 },
          { purchaseId: P2, resource: "gems", amount: 100 },
        ],
      }),
    );

    const view = await service.pending(ACCOUNT);

    expect(view?.restored).toEqual([
      { resource: "gems", amount: 100 },
      { resource: "shard_rare", amount: 5 },
    ]);
  });

  it("выдач нет (играл, но ничего не покупал) — restored пуст, бонус остаётся", async () => {
    const { service } = setup(rowOf({ grants: [] }));

    expect(await service.pending(ACCOUNT)).toMatchObject({ restored: [], bonusGems: 60, continueGems: 0 });
  });

  it("испорченный grants — ошибка с id аккаунта: строку писал наш снимок, это ошибка в коде", async () => {
    const { service } = setup(rowOf({ grants: [{ purchaseId: "не uuid", resource: "gems", amount: 1 }] }));

    await expect(service.pending(ACCOUNT)).rejects.toThrow(ACCOUNT);
  });
});

describe("выдача (claim)", () => {
  let logged: { event: string; fields: Record<string, unknown> }[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((line: unknown) => {
      const fields = JSON.parse(String(line)) as Record<string, unknown>;
      logged.push({ event: String(fields.event), fields });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("тестер с бонусом 60 и двумя выдачами: три начисления с ключами покупок и бонуса, причины purchase, purchase, wipe_compensation — и только потом отметка", async () => {
    const { service, wallet, repository, journal } = setup();

    const result = await service.claim(ACCOUNT, NOW);

    expect(wallet.calls.map((call) => [call.idempotencyKey, call.reason, call.resource, call.amount])).toEqual([
      [`purchase:${P1}:gems`, "purchase", "gems", 150],
      [`purchase:${P2}:gems`, "purchase", "gems", 60],
      [`wipe:${ACCOUNT}:bonus`, "wipe_compensation", "gems", 60],
    ]);
    expect(wallet.calls.map((call) => call.source)).toEqual(["wipe:restore", "wipe:restore", "wipe:tester_bonus"]);
    expect(wallet.calls.every((call) => call.accountId === ACCOUNT)).toBe(true);
    expect(journal).toEqual([`grant:purchase:${P1}:gems`, `grant:purchase:${P2}:gems`, `grant:wipe:${ACCOUNT}:bonus`, "markClaimed"]);
    expect(repository.marks).toEqual([{ accountId: ACCOUNT, at: NOW }]);
    expect(result.alreadyClaimed).toBe(false);
    expect(result.balances.gems).toBe(270);
    expect(result.view).toEqual<CompensationView>({ tester: true, level: 12, bonusGems: 60, restored: [{ resource: "gems", amount: 210 }], continueGems: 0 });
  });

  it("не тестер с выдачей: бонус не начисляется (в снимке bonusGems: 0)", async () => {
    const { service, wallet } = setup(rowOf({ tester: false, bonusGems: 0 }));

    await service.claim(ACCOUNT, NOW);

    expect(wallet.calls.map((call) => call.idempotencyKey)).toEqual([`purchase:${P1}:gems`, `purchase:${P2}:gems`]);
  });

  it("второй шанс за 10 ⭐ — 12 самоцветов с ключом wipe:<accountId>:continue и причиной wipe_compensation", async () => {
    const { service, wallet } = setup(rowOf({ grants: [], bonusGems: 0, continueStars: 10 }));

    const result = await service.claim(ACCOUNT, NOW);

    expect(wallet.calls).toEqual([
      { accountId: ACCOUNT, resource: "gems", amount: 12, reason: "wipe_compensation", source: "wipe:continue", idempotencyKey: `wipe:${ACCOUNT}:continue` },
    ]);
    expect(result.view.continueGems).toBe(12);
  });

  it("второго шанса за звёзды не было (continueStars: 0) — начисления нет", async () => {
    const { service, wallet } = setup(rowOf({ continueStars: 0 }));

    await service.claim(ACCOUNT, NOW);

    expect(wallet.calls.some((call) => call.idempotencyKey.endsWith(":continue"))).toBe(false);
  });

  it("всё сразу: купленное, бонус и второй шанс — в этом порядке", async () => {
    const { service, wallet } = setup(rowOf({ continueStars: 3 }));

    await service.claim(ACCOUNT, NOW);

    expect(wallet.calls.map((call) => call.idempotencyKey)).toEqual([`purchase:${P1}:gems`, `purchase:${P2}:gems`, `wipe:${ACCOUNT}:bonus`, `wipe:${ACCOUNT}:continue`]);
    expect(wallet.calls.at(-1)?.amount).toBe(4);
  });

  it("повторный claim после отметки: alreadyClaimed, grant не вызывался, ответ тот же и без ошибки", async () => {
    const { service, wallet } = setup(rowOf({ continueStars: 10 }));
    const first = await service.claim(ACCOUNT, NOW);
    wallet.calls.length = 0;

    const again = await service.claim(ACCOUNT, new Date(NOW.getTime() + 60_000));

    expect(wallet.calls).toEqual([]);
    expect(again.alreadyClaimed).toBe(true);
    expect(again.view).toEqual(first.view);
    expect(again.balances).toEqual(first.balances);
  });

  it("кошелёк бросил на второй выдаче: claim бросает, отметки нет; повтор начисляет всё один раз", async () => {
    const { service, wallet, repository } = setup();
    wallet.failOnCall = 2;

    await expect(service.claim(ACCOUNT, NOW)).rejects.toThrow("кошелёк недоступен");
    expect(repository.marks).toEqual([]);
    expect(wallet.gems()).toBe(150);

    const retry = await service.claim(ACCOUNT, NOW);

    expect(retry.alreadyClaimed).toBe(false);
    expect(wallet.gems()).toBe(270);
    expect(wallet.entries.size).toBe(3);
    expect(repository.marks).toHaveLength(1);
  });

  it("сбой между начислениями и отметкой безопасен: повтор находит строки по ключам и ничего не удваивает", async () => {
    const { service, wallet, repository } = setup();
    const mark = vi.spyOn(repository, "markClaimed").mockRejectedValueOnce(new Error("база недоступна"));

    await expect(service.claim(ACCOUNT, NOW)).rejects.toThrow("база недоступна");
    expect(wallet.gems()).toBe(270);

    const retry = await service.claim(ACCOUNT, NOW);

    expect(mark).toHaveBeenCalledTimes(2);
    expect(wallet.gems()).toBe(270);
    expect(wallet.entries.size).toBe(3);
    expect(retry.alreadyClaimed).toBe(false);
  });

  it("два нажатия одновременно: на счёт один раз, ровно один ответ «не забирал раньше»", async () => {
    const { service, wallet } = setup();

    const [left, right] = await Promise.all([service.claim(ACCOUNT, NOW), service.claim(ACCOUNT, NOW)]);

    expect(wallet.gems()).toBe(270);
    expect(wallet.entries.size).toBe(3);
    expect([left.alreadyClaimed, right.alreadyClaimed].sort()).toEqual([false, true]);
  });

  it("строки нет — CompensationNotFoundError (404), кошелёк не тронут", async () => {
    const { service, wallet } = setup(null);

    const attempt = service.claim(ACCOUNT, NOW);

    await expect(attempt).rejects.toBeInstanceOf(CompensationNotFoundError);
    await expect(attempt).rejects.toMatchObject({ code: "compensation_not_found", status: 404, message: "Компенсации нет" });
    expect(wallet.calls).toEqual([]);
  });

  it("испорченный grants — ошибка с id аккаунта, grant не вызывался, отметки нет", async () => {
    const { service, wallet, repository } = setup(rowOf({ grants: [{ purchaseId: P1, resource: "gems", amount: -5 }] }));

    await expect(service.claim(ACCOUNT, NOW)).rejects.toThrow(ACCOUNT);

    expect(wallet.calls).toEqual([]);
    expect(repository.marks).toEqual([]);
  });

  it("лог compensation_claimed: аккаунт, тестер, бонус, вернувшиеся самоцветы и самоцветы за второй шанс", async () => {
    const { service } = setup(rowOf({ continueStars: 10 }));

    await service.claim(ACCOUNT, NOW);

    expect(logged.find((entry) => entry.event === "compensation_claimed")?.fields).toMatchObject({
      accountId: ACCOUNT,
      tester: true,
      bonusGems: 60,
      restoredGems: 210,
      continueGems: 12,
    });
  });

  it("повторный claim лог не пишет: выдача была раньше", async () => {
    const { service } = setup();
    await service.claim(ACCOUNT, NOW);
    logged.length = 0;

    await service.claim(ACCOUNT, NOW);

    expect(logged.some((entry) => entry.event === "compensation_claimed")).toBe(false);
  });
});

describe("маршруты /me/compensation", () => {
  const request = { ip: "203.0.113.5", headers: {}, account: { accountId: ACCOUNT, platform: "telegram" as const, platformUserId: "1" } };

  function build(allow = true) {
    const consumed: { rule: RateLimit; key: string }[] = [];
    const limiter = {
      consume: async (rule: RateLimit, key: string) => {
        consumed.push({ rule, key });
        return allow;
      },
    };
    const view: CompensationView = { tester: true, level: 3, bonusGems: 15, restored: [], continueGems: 0 };
    const service = { pending: vi.fn(async () => view), claim: vi.fn(async () => ({ view, alreadyClaimed: false, balances: emptyBalances() })) };
    const controller = new CompensationController(service as never, limiter as never);
    return { controller, service, consumed, view };
  }

  it("GET отдаёт положенное из сервиса по аккаунту из токена", async () => {
    const { controller, service, view } = build();

    expect(await controller.pending(request)).toEqual({ data: view });
    expect(service.pending).toHaveBeenCalledWith(ACCOUNT);
  });

  it("GET без компенсации — { data: null }", async () => {
    const { controller, service } = build();
    service.pending.mockResolvedValueOnce(null as never);

    expect(await controller.pending(request)).toEqual({ data: null });
  });

  it("POST claim: лимит me:compensation — 10 в минуту на аккаунт; сервис вызван", async () => {
    const { controller, service, consumed } = build();

    const response = await controller.claim(request);

    expect(response.data.alreadyClaimed).toBe(false);
    expect(service.claim).toHaveBeenCalledWith(ACCOUNT);
    expect(consumed).toEqual([{ rule: { scope: "me:compensation", limit: 10, windowSec: 60 }, key: ACCOUNT }]);
  });

  it("POST claim сверх лимита — 429 «Слишком часто — попробуй через минуту», сервис не зовётся", async () => {
    const { controller, service } = build(false);

    const attempt = controller.claim(request);

    await expect(attempt).rejects.toBeInstanceOf(RateLimitedError);
    await expect(attempt).rejects.toMatchObject({ message: "Слишком часто — попробуй через минуту" });
    expect(service.claim).not.toHaveBeenCalled();
  });
});

describe("знак «Тестер» в рейтинге", () => {
  const ME = randomUUID();
  const FRIEND = randomUUID();
  const STRANGER = randomUUID();

  function best(accountId: string, patch: Partial<BestRunRow> = {}): BestRunRow {
    return { accountId, displayName: `Игрок ${accountId.slice(0, 4)}`, photoUrl: null, survivalSec: 300, level: 7, startingWeaponId: "knife", enemiesKilled: 90, ...patch };
  }

  function viewOf(rows: BestRunRow[], options: { shadow?: BestRunRow | null; hold?: "silent" | null } = {}): RunsViewService {
    const runs = {
      bestRuns: async () => rows,
      bestRunOf: async () => options.shadow ?? null,
    };
    const leaderboard = {
      top: async () => rows.map((row) => ({ accountId: row.accountId, survivalSec: row.survivalSec })),
      count: async () => rows.length,
      rank: async () => 1,
      best: async () => 300,
      countAbove: async () => 0,
    };
    const rating = { hold: async () => options.hold ?? null };
    return new RunsViewService(runs as never, leaderboard as never, {} as never, rating as never);
  }

  it("у тестера в строке доски tester: true, у остальных поля нет вовсе", async () => {
    const view = viewOf([best(FRIEND, { tester: true }), best(STRANGER)]);

    const { entries } = await view.leaderboardFor(ME, "normal");

    expect(entries[0]).toMatchObject({ tester: true });
    expect(entries[1]).not.toHaveProperty("tester");
  });

  it("идентификаторы чужих аккаунтов и дата знака в строку не попадают", async () => {
    const view = viewOf([best(FRIEND, { tester: true })]);

    const { entries } = await view.leaderboardFor(ME, "normal");

    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(["enemiesKilled", "isMe", "level", "name", "photoUrl", "rank", "startingWeaponId", "survivalSec", "tester"]);
  });

  it("игрок в тени видит себя со знаком, если он тестер", async () => {
    const mine = best(ME, { tester: true, survivalSec: 500 });
    const view = viewOf([best(STRANGER)], { shadow: mine, hold: "silent" });

    const { entries } = await view.leaderboardFor(ME, "normal");

    expect(entries.find((entry) => entry.isMe)).toMatchObject({ tester: true });
  });

  it("игрок в тени без знака — поля tester нет", async () => {
    const view = viewOf([best(STRANGER)], { shadow: best(ME, { survivalSec: 500 }), hold: "silent" });

    const { entries } = await view.leaderboardFor(ME, "normal");

    expect(entries.find((entry) => entry.isMe)).not.toHaveProperty("tester");
  });
});
