import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotMentionBackoff } from "../src/modules/bot-mention/bot-mention-backoff.js";
import type { BotMentionResult, BotMentionRow } from "../src/modules/bot-mention/bot-mention-rules.js";
import { SWEEP_BUDGET_SEC, SWEEP_INTERVAL_MS } from "../src/modules/bot-mention/bot-mention-rules.js";
import { BotMentionSweepService } from "../src/modules/bot-mention/bot-mention-sweep.service.js";
import type { BotMentionRepository, DueAccount } from "../src/modules/bot-mention/bot-mention.repository.js";
import { BotMentionService } from "../src/modules/bot-mention/bot-mention.service.js";
import { SETTINGS, type SettingValue } from "../src/modules/settings/setting-catalog.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { BotMentions, type BotMention, type MentionFinding, type MentionKind, type MentionOutcome } from "../src/platforms/ports/bot-mention.js";
import type { PlatformId } from "../src/platforms/ports/platform.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Ночной проход заданий «юзернейм бота» (tasks/T-0162, шаг 5): один вызов
 * порта на аккаунт в сутки, оба вида вместе; пачка — в пределах половины
 * темпа бота; `retry` обрывает проход и ставит паузу; лок от двух реплик.
 * Репозиторий, порт, Redis и кошелёк — подмены, SQL проверяет
 * `bot-mention.integration.test.ts`.
 */

const LOCK_KEY = "bot-mention:sweep:lock";
const PAUSE_KEY = "bot-mention:pause";
const HOUR = 3_600_000;
/** среда, 21.10.2026, 03:00 по Москве — ночь */
const NIGHT = new Date(Date.UTC(2026, 9, 21, 0));
const TODAY = "2026-10-21";
const OFFER: Record<string, SettingValue> = {
  [SETTINGS.botMentionEnabled.key]: true,
  [SETTINGS.botMentionNameCoins.key]: 100,
  [SETTINGS.botMentionBioGems.key]: 3,
};

function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

interface AccountInfo {
  platform: PlatformId;
  platformUserId: string;
  banned: boolean;
}

class MemoryBotMentions implements BotMentionRepository {
  readonly state = new Map<string, BotMentionRow>();
  readonly accounts = new Map<string, AccountInfo>();
  failDue: Error | null = null;

  /** Аккаунт с начатыми заданиями; `startedAt` задаёт очередь «кто раньше начал». */
  add(accountId: string, platformUserId: string, kinds: readonly MentionKind[], startedAt: Date, info: Partial<AccountInfo> = {}): void {
    this.accounts.set(accountId, { platform: "telegram", platformUserId, banned: false, ...info });
    for (const kind of kinds) {
      this.state.set(`${accountId}|${kind}`, { accountId, kind, startedAt, streak: 0, bestStreak: 0, rewardedDays: 0, lastDay: null, checkedDay: null, checkedAt: null, lastResult: null });
    }
  }

  row(accountId: string, kind: MentionKind): BotMentionRow | undefined {
    return this.state.get(`${accountId}|${kind}`);
  }

  async ensure(accountId: string, kind: MentionKind, at: Date): Promise<void> {
    if (!this.state.has(`${accountId}|${kind}`)) this.add(accountId, "0", [kind], at);
  }

  async rows(accountId: string): Promise<BotMentionRow[]> {
    return [...this.state.values()].filter((row) => row.accountId === accountId).map((row) => ({ ...row }));
  }

  async markChecked(accountId: string, kind: MentionKind, day: string, result: Exclude<BotMentionResult, "present">, at: Date): Promise<void> {
    const row = this.row(accountId, kind);
    if (row === undefined || row.lastDay === day || (row.checkedDay !== null && row.checkedDay > day)) return;
    Object.assign(row, { checkedDay: day, checkedAt: at, lastResult: result });
  }

  async rewardDay(accountId: string, kind: MentionKind, day: string, at: Date): Promise<BotMentionRow | null> {
    const row = this.row(accountId, kind);
    if (row === undefined || (row.lastDay !== null && row.lastDay >= day)) return null;
    const streak = row.lastDay === previousDay(day) ? row.streak + 1 : 1;
    Object.assign(row, { streak, bestStreak: Math.max(row.bestStreak, streak), rewardedDays: row.rewardedDays + 1, lastDay: day, checkedDay: day, checkedAt: at, lastResult: "present" });
    return { ...row };
  }

  async due(platform: PlatformId, day: string, kinds: readonly MentionKind[], limit: number): Promise<DueAccount[]> {
    if (this.failDue !== null) throw this.failDue;
    const grouped = new Map<string, BotMentionRow[]>();
    for (const row of this.state.values()) {
      const account = this.accounts.get(row.accountId);
      if (account === undefined || account.platform !== platform || account.banned || !kinds.includes(row.kind) || row.checkedDay === day) continue;
      grouped.set(row.accountId, [...(grouped.get(row.accountId) ?? []), row]);
    }
    const rank = (rows: BotMentionRow[]) => [rows.map((row) => row.checkedDay ?? "0000-00-00").sort()[0] ?? "", Math.min(...rows.map((row) => row.startedAt.getTime()))] as const;
    return [...grouped.entries()]
      .sort(([idA, rowsA], [idB, rowsB]) => {
        const [dayA, startedA] = rank(rowsA);
        const [dayB, startedB] = rank(rowsB);
        return dayA.localeCompare(dayB) || startedA - startedB || idA.localeCompare(idB);
      })
      .slice(0, limit)
      .map(([accountId, rows]) => ({ accountId, platformUserId: this.accounts.get(accountId)?.platformUserId ?? "", kinds: rows.map((row) => row.kind) }));
  }
}

class FakeWallet {
  readonly grants: GrantInput[] = [];
  private readonly entries = new Map<string, number>();
  /** аккаунты, которым начисление падает: база отказала */
  readonly failFor = new Set<string>();

  async grant(input: GrantInput): Promise<GrantResult> {
    if (this.failFor.has(input.accountId)) throw new Error("база недоступна");
    const existing = this.entries.get(input.idempotencyKey);
    if (existing !== undefined) return { credited: existing, balance: 0, duplicate: true };
    this.entries.set(input.idempotencyKey, input.amount);
    this.grants.push(input);
    return { credited: input.amount, balance: 0, duplicate: false };
  }
}

class FakePort implements BotMention {
  readonly platform = "telegram" as const;
  configured = true;
  ratePerSec = 25;
  readonly calls: { id: string; kinds: MentionKind[] }[] = [];
  answer: (id: string, kinds: readonly MentionKind[]) => MentionOutcome | Promise<MentionOutcome> = (_id, kinds) => everyone("present", kinds);

  botUsername(): string {
    return "game_bot";
  }

  async check(platformUserId: string, kinds: readonly MentionKind[]): Promise<MentionOutcome> {
    this.calls.push({ id: platformUserId, kinds: [...kinds] });
    return await this.answer(platformUserId, kinds);
  }
}

function everyone(finding: MentionFinding, kinds: readonly MentionKind[]): MentionOutcome {
  const findings: Partial<Record<MentionKind, MentionFinding>> = {};
  for (const kind of kinds) findings[kind] = finding;
  return { status: "checked", findings };
}

/** Redis с временем, которое двигает тест: `SET NX PX`, `PTTL`, снятие лока скриптом по токену. */
class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  private now = 0;

  async set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null> {
    const px = args.indexOf("PX");
    if (args.includes("NX") && this.live(key) !== undefined) return null;
    this.store.set(key, { value, expiresAt: this.now + (px >= 0 ? Number(args[px + 1]) : Number.MAX_SAFE_INTEGER) });
    return "OK";
  }

  async pttl(key: string): Promise<number> {
    const entry = this.live(key);
    return entry === undefined ? -2 : entry.expiresAt - this.now;
  }

  /** Команда Redis EVAL (скрипт снятия лока по токену), а не исполнение кода в тесте. */
  async eval(_script: string, _keys: number, key: string, token: string): Promise<number> {
    if (this.live(key)?.value !== token) return 0;
    this.store.delete(key);
    return 1;
  }

  peek(key: string): string | undefined {
    return this.live(key)?.value;
  }

  advance(ms: number): void {
    this.now += ms;
  }

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.store.get(key);
    return entry !== undefined && entry.expiresAt > this.now ? entry : undefined;
  }
}

function setup(options: { settings?: Record<string, SettingValue> } = {}) {
  const repository = new MemoryBotMentions();
  const port = new FakePort();
  const redis = new FakeRedis();
  const wallet = new FakeWallet();
  const settings = panelSettings({ ...OFFER, ...options.settings });
  const mentions = new BotMentions([port]);
  const backoff = new BotMentionBackoff(redis as never);
  const service = new BotMentionService(repository, mentions, wallet as unknown as WalletService, settings, backoff);
  const sweep = new BotMentionSweepService(repository, mentions, service, settings, redis as never, backoff);
  const pauses: number[] = [];
  sweep.pause = async (ms) => {
    pauses.push(ms);
  };
  let now = NIGHT;
  sweep.clock = () => now;
  return {
    repository,
    port,
    redis,
    wallet,
    settings,
    sweep,
    pauses,
    setNow: (at: Date) => {
      now = at;
    },
  };
}

type World = ReturnType<typeof setup>;

/** n аккаунтов с именем, id 7000000NN, начавших по порядку. */
function crowd(world: World, count: number, kinds: readonly MentionKind[] = ["name"]): string[] {
  return Array.from({ length: count }, (_, index) => {
    const accountId = `00000000-0000-4000-8000-0000000062${String(index + 10)}`;
    world.repository.add(accountId, String(700_000_001 + index), kinds, new Date(NIGHT.getTime() - (count - index) * HOUR));
    return accountId;
  });
}

function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((line: unknown) => {
      lines.push({ level, ...(JSON.parse(String(line)) as Record<string, unknown>) });
    });
  }
  return lines;
}

describe("ночной проход заданий «юзернейм бота»", () => {
  // Строки лога модуля в вывод тестов не попадают; тесты о логе перехватывают их сами.
  beforeEach(() => {
    for (const level of ["log", "warn"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("константы прохода: бюджет 240 с, раз в 5 минут", () => {
    expect(SWEEP_BUDGET_SEC).toBe(240);
    expect(SWEEP_INTERVAL_MS).toBe(300_000);
  });

  it("три аккаунта, у одного оба вида: по одному вызову порта на аккаунт, у того — с двумя видами", async () => {
    const world = setup();
    world.repository.add("00000000-0000-4000-8000-000000006211", "700000001", ["name", "bio"], new Date(NIGHT.getTime() - 3 * HOUR));
    world.repository.add("00000000-0000-4000-8000-000000006212", "700000002", ["name"], new Date(NIGHT.getTime() - 2 * HOUR));
    world.repository.add("00000000-0000-4000-8000-000000006213", "700000003", ["bio"], new Date(NIGHT.getTime() - HOUR));

    await world.sweep.run();

    expect(world.port.calls).toEqual([
      { id: "700000001", kinds: ["name", "bio"] },
      { id: "700000002", kinds: ["name"] },
      { id: "700000003", kinds: ["bio"] },
    ]);
  });

  it("весь результат: сколько аккаунтов проверено, и награда по найденному", async () => {
    const world = setup();
    const [first, second] = crowd(world, 2, ["name", "bio"]);
    world.port.answer = (id, kinds) => (id === "700000001" ? everyone("present", kinds) : { status: "checked", findings: { name: "absent", bio: "hidden" } });

    const result = await world.sweep.run();

    expect(result).toEqual({ status: "done", checked: 2, unavailable: 0, retried: 0, failed: 0, stopped: false });
    expect(world.wallet.grants.map((grant) => [grant.accountId, grant.resource, grant.amount, grant.reason, grant.source])).toEqual([
      [first, "coins", 100, "task_reward", "bot-mention:name"],
      [first, "gems", 3, "task_reward", "bot-mention:bio"],
    ]);
    expect(world.repository.row(first ?? "", "name")).toMatchObject({ streak: 1, lastDay: TODAY, checkedDay: TODAY, lastResult: "present" });
    expect(world.repository.row(second ?? "", "name")).toMatchObject({ streak: 0, lastDay: null, checkedDay: TODAY, lastResult: "absent" });
    expect(world.repository.row(second ?? "", "bio")).toMatchObject({ lastResult: "hidden", checkedDay: TODAY });
    // повторный проход в те же сутки — пусто
    world.port.calls.length = 0;
    expect((await world.sweep.run()).status).toBe("done");
    expect(world.port.calls).toEqual([]);
  });

  it("бюджет: темп 4 в секунду и бюджет 2 с — не больше floor(4 × 2 / 2) = 4 аккаунтов за проход, пауза — 500 мс; остальные в следующем проходе", async () => {
    const world = setup();
    world.port.ratePerSec = 4;
    world.sweep.budgetSec = 2;
    crowd(world, 7);

    await world.sweep.run();
    expect(world.port.calls.map((call) => call.id)).toEqual(["700000001", "700000002", "700000003", "700000004"]);
    // половина темпа бота: 2 вызова в секунду — пауза 500 мс между вызовами
    expect(world.pauses).toEqual([500, 500, 500]);

    await world.sweep.run();
    expect(world.port.calls.map((call) => call.id).slice(4)).toEqual(["700000005", "700000006", "700000007"]);
    await world.sweep.run();
    expect(world.port.calls).toHaveLength(7);
  });

  it("настоящие числа: темп Telegram 25 в секунду и бюджет 240 с — 3000 аккаунтов за проход, пауза 80 мс", async () => {
    const world = setup();
    world.port.answer = () => ({ status: "unavailable", reason: "403" });
    crowd(world, 3);
    await world.sweep.run();
    expect(world.pauses).toEqual([80, 80]);
    // Сколько аккаунтов проход просит у очереди за раз: floor(25 × 240 / 2).
    const asked: number[] = [];
    const original = world.repository.due.bind(world.repository);
    world.repository.due = async (platform, day, kinds, limit) => {
      asked.push(limit);
      return await original(platform, day, kinds, limit);
    };
    await world.sweep.run();
    expect(asked).toEqual([3000]);
  });

  it("retry на втором аккаунте: проход оборван, третий не тронут, ключ паузы стоит; пока пауза жива — ноль вызовов", async () => {
    const world = setup();
    const [first, second, third] = crowd(world, 3);
    world.port.answer = (id, kinds) => (id === "700000002" ? { status: "retry", afterSec: 20 } : everyone("present", kinds));

    const result = await world.sweep.run();

    expect(result).toEqual({ status: "done", checked: 1, unavailable: 0, retried: 1, failed: 0, stopped: true });
    expect(world.port.calls.map((call) => call.id)).toEqual(["700000001", "700000002"]);
    expect(world.redis.peek(PAUSE_KEY)).toBeDefined();
    expect(await world.redis.pttl(PAUSE_KEY)).toBe(20_000);
    expect(world.repository.row(first ?? "", "name")?.checkedDay).toBe(TODAY);
    expect(world.repository.row(second ?? "", "name")?.checkedDay).toBeNull();
    expect(world.repository.row(third ?? "", "name")?.checkedDay).toBeNull();

    world.port.answer = (_id, kinds) => everyone("present", kinds);
    expect(await world.sweep.run()).toEqual({ status: "skipped", reason: "paused" });
    expect(world.port.calls).toHaveLength(2);
    // лок после прохода под паузой не висит
    expect(world.redis.peek(LOCK_KEY)).toBeUndefined();

    world.redis.advance(21_000);
    await world.sweep.run();
    expect(world.port.calls.map((call) => call.id).slice(2)).toEqual(["700000002", "700000003"]);
  });

  it("исключение порта — как retry: проход оборван, пауза на несколько секунд, ошибка не уходит наверх", async () => {
    const world = setup();
    crowd(world, 3);
    const lines = captureLogs();
    world.port.answer = (id, kinds) => {
      if (id === "700000002") throw new Error("Иван @game_bot");
      return everyone("present", kinds);
    };

    const result = await world.sweep.run();

    expect(result).toMatchObject({ status: "done", checked: 1, retried: 1, stopped: true });
    expect(world.port.calls).toHaveLength(2);
    expect(await world.redis.pttl(PAUSE_KEY)).toBe(5_000);
    expect(JSON.stringify(lines)).not.toContain("Иван");
  });

  it("unavailable: оба вида помечены проверенными на сегодня, в этот же день аккаунт больше не выбирается", async () => {
    const world = setup();
    const [account] = crowd(world, 1, ["name", "bio"]);
    world.port.answer = () => ({ status: "unavailable", reason: "403" });

    const result = await world.sweep.run();

    expect(result).toEqual({ status: "done", checked: 0, unavailable: 1, retried: 0, failed: 0, stopped: false });
    for (const kind of ["name", "bio"] as const) expect(world.repository.row(account ?? "", kind)).toMatchObject({ checkedDay: TODAY, lastResult: "unavailable", lastDay: null });
    expect(world.wallet.grants).toEqual([]);

    await world.sweep.run();
    await world.sweep.run();
    expect(world.port.calls).toHaveLength(1);
    // следующие игровые сутки — снова очередь
    world.setNow(new Date(NIGHT.getTime() + 24 * HOUR));
    await world.sweep.run();
    expect(world.port.calls).toHaveLength(2);
  });

  it("id не из 1–15 цифр (аккаунт разработчика, слишком длинный): порт не зовётся, виды помечены unavailable, остальные проверяются", async () => {
    const world = setup();
    const [dev, long, normal] = crowd(world, 3);
    world.repository.accounts.set(dev ?? "", { platform: "telegram", platformUserId: "dev-1a2b", banned: false });
    world.repository.accounts.set(long ?? "", { platform: "telegram", platformUserId: "12345678901234567890", banned: false });

    await world.sweep.run();

    expect(world.port.calls).toEqual([{ id: "700000003", kinds: ["name"] }]);
    expect(world.repository.row(dev ?? "", "name")).toMatchObject({ lastResult: "unavailable", checkedDay: TODAY });
    expect(world.repository.row(long ?? "", "name")).toMatchObject({ lastResult: "unavailable", checkedDay: TODAY });
    expect(world.repository.row(normal ?? "", "name")).toMatchObject({ lastResult: "present" });
    // пауза нужна между вызовами площадки, а не между пропусками
    expect(world.pauses).toEqual([]);
  });

  it("настройка выключена — ноль вызовов и лок не берётся; включена, но наград нет — то же", async () => {
    const off = setup({ settings: { [SETTINGS.botMentionEnabled.key]: false } });
    crowd(off, 2);
    expect(await off.sweep.run()).toEqual({ status: "skipped", reason: "disabled" });
    expect(off.port.calls).toEqual([]);
    expect(off.redis.peek(LOCK_KEY)).toBeUndefined();

    const free = setup({ settings: { [SETTINGS.botMentionNameCoins.key]: 0, [SETTINGS.botMentionBioGems.key]: 0 } });
    crowd(free, 2);
    expect(await free.sweep.run()).toEqual({ status: "skipped", reason: "disabled" });
    expect(free.port.calls).toEqual([]);
  });

  it("виды без награды в проход не берутся: порт получает только оплачиваемые", async () => {
    const world = setup({ settings: { [SETTINGS.botMentionBioGems.key]: 0 } });
    crowd(world, 2, ["name", "bio"]);
    await world.sweep.run();
    expect(world.port.calls).toEqual([
      { id: "700000001", kinds: ["name"] },
      { id: "700000002", kinds: ["name"] },
    ]);
    // bio не проверялось — и проверенным не помечено: появится награда, и оно дойдёт до очереди
    const bio = [...world.repository.state.values()].filter((row) => row.kind === "bio");
    expect(bio).toHaveLength(2);
    for (const row of bio) expect(row.checkedDay).toBeNull();
  });

  it("лок занят другой репликой — ноль вызовов, чужой лок не снят", async () => {
    const world = setup();
    crowd(world, 2);
    await world.redis.set(LOCK_KEY, "other-replica", "PX", 600_000, "NX");

    expect(await world.sweep.run()).toEqual({ status: "skipped", reason: "locked" });
    expect(world.port.calls).toEqual([]);
    expect(world.redis.peek(LOCK_KEY)).toBe("other-replica");
  });

  it("лок берётся на 10 минут на время прохода и снимается после; чужой с тем же ключом не трогает", async () => {
    const world = setup();
    crowd(world, 1);
    let ttlDuringPass = 0;
    world.port.answer = async (_id, kinds) => {
      ttlDuringPass = await world.redis.pttl(LOCK_KEY);
      return everyone("present", kinds);
    };
    await world.sweep.run();
    expect(ttlDuringPass).toBe(600_000);
    expect(world.redis.peek(LOCK_KEY)).toBeUndefined();
  });

  it("лок снимается и когда проход упал", async () => {
    const world = setup();
    crowd(world, 1);
    world.repository.failDue = new Error("база недоступна");
    await expect(world.sweep.run()).rejects.toThrow("база недоступна");
    expect(world.redis.peek(LOCK_KEY)).toBeUndefined();
  });

  it("без порта площадки (MAX, VK) аккаунтов не берёт; заблокированных тоже", async () => {
    const world = setup();
    const [max, banned, normal] = crowd(world, 3);
    world.repository.accounts.set(max ?? "", { platform: "max", platformUserId: "700000001", banned: false });
    world.repository.accounts.set(banned ?? "", { platform: "telegram", platformUserId: "700000002", banned: true });

    await world.sweep.run();

    expect(world.port.calls).toEqual([{ id: "700000003", kinds: ["name"] }]);
    expect(world.repository.row(normal ?? "", "name")?.checkedDay).toBe(TODAY);
    expect(world.repository.row(max ?? "", "name")?.checkedDay).toBeNull();
    expect(world.repository.row(banned ?? "", "name")?.checkedDay).toBeNull();
  });

  it("бросивших не перестаём проверять: аккаунт с отметкой давних суток снова в очереди, и раньше тех, кого проверили вчера", async () => {
    const world = setup();
    const [fresh, yesterday, longAgo] = crowd(world, 3);
    Object.assign(world.repository.row(yesterday ?? "", "name") ?? {}, { checkedDay: "2026-10-20", lastResult: "absent" });
    Object.assign(world.repository.row(longAgo ?? "", "name") ?? {}, { checkedDay: "2026-09-01", lastResult: "absent" });
    world.port.answer = () => ({ status: "unavailable", reason: "403" });

    await world.sweep.run();

    // сначала никогда не проверенные, потом самые давние
    expect(world.port.calls.map((call) => call.id)).toEqual(["700000001", "700000003", "700000002"]);
    expect(fresh).toBeDefined();
  });

  it("сбой начисления у одного аккаунта не останавливает проход; награда доплатится в следующем", async () => {
    const world = setup();
    const [first, second, third] = crowd(world, 3);
    world.wallet.failFor.add(second ?? "");
    const lines = captureLogs();

    const result = await world.sweep.run();

    expect(result).toEqual({ status: "done", checked: 2, unavailable: 0, retried: 0, failed: 1, stopped: false });
    expect(world.port.calls).toHaveLength(3);
    expect(world.repository.row(first ?? "", "name")?.lastDay).toBe(TODAY);
    expect(world.repository.row(second ?? "", "name")).toMatchObject({ lastDay: null, checkedDay: null });
    expect(world.repository.row(third ?? "", "name")?.lastDay).toBe(TODAY);
    expect(lines).toContainEqual({ level: "warn", module: "bot-mention", event: "bot_mention_account_failed", accountId: second, kind: "name", reason: "Error" });

    world.wallet.failFor.clear();
    await world.sweep.run();
    expect(world.port.calls.map((call) => call.id).slice(3)).toEqual(["700000002"]);
    expect(world.repository.row(second ?? "", "name")?.lastDay).toBe(TODAY);
  });

  it("три сбоя подряд — это не один «ядовитый» аккаунт, а сбой системы: проход останавливается", async () => {
    const world = setup();
    const accounts = crowd(world, 6);
    for (const account of accounts) world.wallet.failFor.add(account);

    const result = await world.sweep.run();

    expect(result).toMatchObject({ status: "done", failed: 3, stopped: true });
    expect(world.port.calls).toHaveLength(3);
  });

  it("граница суток посреди прохода: аккаунт, проверенный после полуночи по Москве, награждается за новые сутки, а не за старые", async () => {
    const world = setup();
    const [before, after] = crowd(world, 2);
    const T1 = new Date(Date.UTC(2026, 9, 21, 20, 59, 30));
    const T2 = new Date(Date.UTC(2026, 9, 21, 21, 0, 30));
    world.setNow(T1);
    world.port.answer = (id, kinds) => {
      if (id === "700000002") world.setNow(T2);
      return everyone("present", kinds);
    };

    await world.sweep.run();

    expect(world.repository.row(before ?? "", "name")).toMatchObject({ lastDay: "2026-10-21", streak: 1 });
    expect(world.repository.row(after ?? "", "name")).toMatchObject({ lastDay: "2026-10-22", streak: 1 });
    expect(world.wallet.grants.map((grant) => grant.idempotencyKey)).toEqual([
      `bot-mention:${before}:name:2026-10-21:coins`,
      `bot-mention:${after}:name:2026-10-22:coins`,
    ]);
  });

  it("лог прохода: итог по площадке, день награды и пауза — без имён и текстов", async () => {
    const world = setup();
    const [first] = crowd(world, 3);
    world.port.answer = (id, kinds) => {
      if (id === "700000002") return { status: "unavailable", reason: "403" };
      if (id === "700000003") return { status: "retry", afterSec: 7 };
      return everyone("present", kinds);
    };
    const lines = captureLogs();

    await world.sweep.run();

    expect(lines).toEqual([
      { level: "log", module: "bot-mention", event: "bot_mention_day_rewarded", accountId: first, kind: "name", streak: 1 },
      { level: "warn", module: "bot-mention", event: "bot_mention_paused", afterSec: 7 },
      { level: "log", module: "bot-mention", event: "bot_mention_tick", platform: "telegram", checked: 1, retried: 1, unavailable: 1 },
    ]);
  });

  it("пустой проход ничего не пишет в лог", async () => {
    const world = setup();
    const lines = captureLogs();
    expect(await world.sweep.run()).toEqual({ status: "done", checked: 0, unavailable: 0, retried: 0, failed: 0, stopped: false });
    expect(lines).toEqual([]);
  });
});
