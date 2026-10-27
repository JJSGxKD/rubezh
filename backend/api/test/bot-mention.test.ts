import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { BotMentionBackoff } from "../src/modules/bot-mention/bot-mention-backoff.js";
import { BotMentionUnavailableForPlatformError, TaskNotOfferedError } from "../src/modules/bot-mention/bot-mention-errors.js";
import { BOT_MENTION_KINDS, activeStreak, canCheckUserId, offered, offeredKinds, rewardOf, type BotMentionResult, type BotMentionRow } from "../src/modules/bot-mention/bot-mention-rules.js";
import type { BotMentionRepository, DueAccount } from "../src/modules/bot-mention/bot-mention.repository.js";
import { BotMentionService } from "../src/modules/bot-mention/bot-mention.service.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { SETTING_LIST, SETTINGS, type SettingValue } from "../src/modules/settings/setting-catalog.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { BotMentions, containsMention, type BotMention, type MentionFinding, type MentionKind, type MentionOutcome } from "../src/platforms/ports/bot-mention.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Задания «юзернейм бота» (docs/35-stage4-plan.md Р110, tasks/T-0162):
 * проверка имени и bio через порт площадки, награда за игровые сутки, серия,
 * ручная проверка. Репозиторий, порт и кошелёк — подмены; SQL-часть
 * (`UPDATE … RETURNING`, `due`, каскад) — `bot-mention.integration.test.ts`,
 * ночной проход — `bot-mention-sweep.test.ts`.
 *
 * Юзернейм бота в тестах вымышленный — `game_bot`.
 */

const ME = "00000000-0000-4000-8000-0000000062a1";
const PLAYER: AccountRef = { accountId: ME, platform: "telegram", platformUserId: "555000111" };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** среда, 21.10.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 9, 21, 9));
const TODAY = "2026-10-21";
const NONE = { coins: 0, gems: 0, shards: 0 };

/** Имя: 100 монет и 2 осколка, bio: 3 самоцвета — оба вида показываются. */
const OFFER: Record<string, SettingValue> = {
  [SETTINGS.botMentionEnabled.key]: true,
  [SETTINGS.botMentionNameCoins.key]: 100,
  [SETTINGS.botMentionNameShards.key]: 2,
  [SETTINGS.botMentionBioGems.key]: 3,
};

function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
}

function dayOf(at: Date, plusDays: number): Date {
  return new Date(at.getTime() + plusDays * DAY);
}

/** Состояние заданий в памяти — так же, как его меняют `UPDATE` репозитория. */
class MemoryBotMentions implements BotMentionRepository {
  readonly state = new Map<string, BotMentionRow>();

  row(accountId: string, kind: MentionKind): BotMentionRow | undefined {
    return this.state.get(`${accountId}|${kind}`);
  }

  async ensure(accountId: string, kind: MentionKind, at: Date): Promise<void> {
    const key = `${accountId}|${kind}`;
    if (this.state.has(key)) return;
    this.state.set(key, { accountId, kind, startedAt: at, streak: 0, bestStreak: 0, rewardedDays: 0, lastDay: null, checkedDay: null, checkedAt: null, lastResult: null });
  }

  async rows(accountId: string): Promise<BotMentionRow[]> {
    return [...this.state.values()].filter((row) => row.accountId === accountId).map((row) => ({ ...row }));
  }

  async markChecked(accountId: string, kind: MentionKind, day: string, result: Exclude<BotMentionResult, "present">, at: Date): Promise<void> {
    const row = this.row(accountId, kind);
    // Награждённые сутки отметкой «убрал» не перекрываются, а проверка не идёт назад.
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

  async due(): Promise<DueAccount[]> {
    return [];
  }
}

class FakeWallet {
  readonly grants: GrantInput[] = [];
  private readonly entries = new Map<string, number>();
  /** суточный потолок: сколько кошелёк готов положить по ресурсу */
  readonly caps = new Map<string, number>();
  /** ресурс, на котором следующее начисление упадёт */
  failOn: string | null = null;

  async grant(input: GrantInput): Promise<GrantResult> {
    if (this.failOn === input.resource) {
      this.failOn = null;
      throw new Error("база недоступна");
    }
    const existing = this.entries.get(input.idempotencyKey);
    if (existing !== undefined) return { credited: existing, balance: 0, duplicate: true };
    const credited = Math.min(input.amount, this.caps.get(input.resource) ?? input.amount);
    this.entries.set(input.idempotencyKey, credited);
    this.grants.push(input);
    return { credited, balance: 0, duplicate: false };
  }
}

class FakePort implements BotMention {
  readonly platform = "telegram" as const;
  configured = true;
  ratePerSec = 25;
  readonly calls: { id: string; kinds: MentionKind[] }[] = [];
  answer: (id: string, kinds: readonly MentionKind[]) => MentionOutcome | Promise<MentionOutcome> = (_id, kinds) => allPresent(kinds);

  botUsername(): string {
    return "game_bot";
  }

  async check(platformUserId: string, kinds: readonly MentionKind[]): Promise<MentionOutcome> {
    this.calls.push({ id: platformUserId, kinds: [...kinds] });
    return await this.answer(platformUserId, kinds);
  }
}

function found(findings: Partial<Record<MentionKind, MentionFinding>>): MentionOutcome {
  return { status: "checked", findings };
}

function allPresent(kinds: readonly MentionKind[]): MentionOutcome {
  const findings: Partial<Record<MentionKind, MentionFinding>> = {};
  for (const kind of kinds) findings[kind] = "present";
  return { status: "checked", findings };
}

/** Redis с временем, которое двигает тест: `SET … PX`, `PTTL`. */
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
  const service = new BotMentionService(repository, new BotMentions([port]), wallet as unknown as WalletService, settings, new BotMentionBackoff(redis as never));
  return { service, repository, port, redis, wallet, settings };
}

describe("правила заданий", () => {
  it("серия живёт, пока последняя награда — сегодня или вчера; позавчера и раньше — 0", () => {
    const row = (lastDay: string | null) => ({ streak: 5, lastDay });
    expect(activeStreak(row("2026-10-21"), "2026-10-21")).toBe(5);
    expect(activeStreak(row("2026-10-20"), "2026-10-21")).toBe(5);
    expect(activeStreak(row("2026-10-19"), "2026-10-21")).toBe(0);
    expect(activeStreak(row(null), "2026-10-21")).toBe(0);
    // граница месяца и года считается по календарю, а не вычитанием из числа
    expect(activeStreak(row("2026-10-31"), "2026-11-01")).toBe(5);
    expect(activeStreak(row("2026-12-31"), "2027-01-01")).toBe(5);
    expect(activeStreak(row("2026-12-30"), "2027-01-01")).toBe(0);
  });

  it("награда — из ключей панели, показывается при сумме больше нуля", () => {
    const settings = panelSettings(OFFER);
    expect(rewardOf("name", settings)).toEqual({ coins: 100, gems: 0, shards: 2 });
    expect(rewardOf("bio", settings)).toEqual({ coins: 0, gems: 3, shards: 0 });
    expect(offered({ coins: 0, gems: 0, shards: 1 })).toBe(true);
    expect(offered(NONE)).toBe(false);
    expect(offeredKinds(settings)).toEqual(["name", "bio"]);
    expect(offeredKinds(panelSettings({ ...OFFER, [SETTINGS.botMentionBioGems.key]: 0 }))).toEqual(["name"]);
    // выключатель сильнее наград
    expect(offeredKinds(panelSettings({ ...OFFER, [SETTINGS.botMentionEnabled.key]: false }))).toEqual([]);
  });

  it("id игрока уходит в порт только если помещается в число без потери точности: 1–15 цифр", () => {
    for (const id of ["1", "555000111", "123456789012345"]) expect(canCheckUserId(id), id).toBe(true);
    for (const id of ["1234567890123456", "12345678901234567890", "dev-abc", "", "-100", "12 3", "1e5", "٣٣"]) expect(canCheckUserId(id), id).toBe(false);
  });
});

describe("ключи настроек", () => {
  it("семь ключей группы «Юзернейм бота»: выключено, награды 0, пределы — суточные потолки task_reward", () => {
    const keys = [
      [SETTINGS.botMentionEnabled, "bot-mention.enabled", false],
      [SETTINGS.botMentionNameCoins, "bot-mention.name.coins", 0],
      [SETTINGS.botMentionNameGems, "bot-mention.name.gems", 0],
      [SETTINGS.botMentionNameShards, "bot-mention.name.shards", 0],
      [SETTINGS.botMentionBioCoins, "bot-mention.bio.coins", 0],
      [SETTINGS.botMentionBioGems, "bot-mention.bio.gems", 0],
      [SETTINGS.botMentionBioShards, "bot-mention.bio.shards", 0],
    ] as const;
    for (const [setting, key, fallback] of keys) {
      expect(setting.key).toBe(key);
      expect(setting.group).toBe("Юзернейм бота");
      expect(setting.fallback).toBe(fallback);
      // окружения нет: ключ правится только в панели
      expect(setting.fromEnv({} as never)).toBeNull();
      expect(SETTING_LIST.some((entry) => entry.key === key)).toBe(true);
    }
    expect(SETTINGS.botMentionEnabled.kind).toBe("boolean");
    expect(SETTINGS.botMentionEnabled.title).toBe("Задания «юзернейм бота»");
    expect(SETTINGS.botMentionEnabled.hint).toBe(
      "Игрок вписывает юзернейм бота в имя или bio, сервер раз в игровые сутки проверяет и платит за сутки. Вид без награды игрокам не показывается",
    );
    const limits = [
      [SETTINGS.botMentionNameCoins, 10_000],
      [SETTINGS.botMentionBioCoins, 10_000],
      [SETTINGS.botMentionNameGems, 50],
      [SETTINGS.botMentionBioGems, 50],
      [SETTINGS.botMentionNameShards, 100],
      [SETTINGS.botMentionBioShards, 100],
    ] as const;
    for (const [setting, max] of limits) {
      expect(setting.kind).toBe("number");
      expect(setting.range).toMatchObject({ min: 0, max });
      expect(setting.schema.safeParse(max).success, `${setting.key}: предел`).toBe(true);
      expect(setting.schema.safeParse(max + 1).success, `${setting.key}: сверх предела`).toBe(false);
      expect(setting.schema.safeParse(-1).success, `${setting.key}: минус`).toBe(false);
      expect(setting.schema.safeParse(1.5).success, `${setting.key}: дробь`).toBe(false);
    }
  });
});

describe("задания «юзернейм бота»", () => {
  // Строки лога модуля в вывод тестов не попадают; тесты о логе перехватывают их сами.
  beforeEach(() => {
    for (const level of ["log", "warn"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function grantsOf(wallet: FakeWallet) {
    return wallet.grants.map((grant) => [grant.resource, grant.amount, grant.reason, grant.source, grant.idempotencyKey]);
  }

  it("выключено: вида нет в ответе, проверка — 404 и площадку не спрашивает", async () => {
    const { service, port } = setup({ settings: { [SETTINGS.botMentionEnabled.key]: false } });
    expect(await service.view(PLAYER, NOON)).toEqual({ botUsername: "game_bot", tasks: [] });
    const failure = await service.check(PLAYER, "name", NOON).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TaskNotOfferedError);
    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).status).toBe(404);
    expect(port.calls).toEqual([]);
  });

  it("награда вида 0: вид не показывается и не проверяется, соседний — да", async () => {
    const { service, repository, port } = setup({ settings: { [SETTINGS.botMentionBioGems.key]: 0 } });
    expect((await service.view(PLAYER, NOON)).tasks.map((task) => task.kind)).toEqual(["name"]);
    await expect(service.check(PLAYER, "bio", NOON)).rejects.toBeInstanceOf(TaskNotOfferedError);
    expect(port.calls).toEqual([]);
    // отказ не начинает задание: строки состояния нет
    expect(repository.row(ME, "bio")).toBeUndefined();
    expect((await service.check(PLAYER, "name", NOON)).outcome).toBe("present");
  });

  it("площадка без порта (web): юзернейма нет, заданий нет, проверка — 404", async () => {
    const { service, port } = setup();
    const web: AccountRef = { accountId: ME, platform: "web", platformUserId: "visitor-1" };
    expect(await service.view(web, NOON)).toEqual({ botUsername: null, tasks: [] });
    const failure = await service.check(web, "name", NOON).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BotMentionUnavailableForPlatformError);
    expect((failure as DomainError).status).toBe(404);
    expect(port.calls).toEqual([]);
  });

  it("бот площадки не настроен: порта «нет» — как у площадки без заданий", async () => {
    const { service, port } = setup();
    port.configured = false;
    expect(await service.view(PLAYER, NOON)).toEqual({ botUsername: null, tasks: [] });
    await expect(service.check(PLAYER, "name", NOON)).rejects.toBeInstanceOf(BotMentionUnavailableForPlatformError);
  });

  it("вид до первой проверки: награда видна, задание не начато, серия 0", async () => {
    const { service, repository } = setup();
    expect(await service.view(PLAYER, NOON)).toEqual({
      botUsername: "game_bot",
      tasks: [
        { kind: "name", reward: { coins: 100, gems: 0, shards: 2 }, started: false, streak: 0, bestStreak: 0, rewardedToday: false, lastResult: null, checkedAt: null },
        { kind: "bio", reward: { coins: 0, gems: 3, shards: 0 }, started: false, streak: 0, bestStreak: 0, rewardedToday: false, lastResult: null, checkedAt: null },
      ],
    });
    // просмотр экрана задание не начинает
    expect(repository.state.size).toBe(0);
  });

  it("present: награда по каждому ненулевому ресурсу, причина task_reward, ключи с датой и ресурсом, самоцветов в запросе нет", async () => {
    const { service, wallet, port, repository } = setup();
    const result = await service.check(PLAYER, "name", NOON);

    expect(result.outcome).toBe("present");
    expect(result.credited).toEqual({ coins: 100, gems: 0, shards: 2 });
    expect(wallet.grants).toEqual([
      { accountId: ME, resource: "coins", amount: 100, reason: "task_reward", source: "bot-mention:name", idempotencyKey: `bot-mention:${ME}:name:${TODAY}:coins`, at: NOON },
      { accountId: ME, resource: "shard_common", amount: 2, reason: "task_reward", source: "bot-mention:name", idempotencyKey: `bot-mention:${ME}:name:${TODAY}:shard_common`, at: NOON },
    ]);
    expect(port.calls).toEqual([{ id: "555000111", kinds: ["name"] }]);
    expect(repository.row(ME, "name")).toMatchObject({ streak: 1, bestStreak: 1, rewardedDays: 1, lastDay: TODAY, checkedDay: TODAY, lastResult: "present" });
    expect(result.view.tasks.find((task) => task.kind === "name")).toEqual({
      kind: "name",
      reward: { coins: 100, gems: 0, shards: 2 },
      started: true,
      streak: 1,
      bestStreak: 1,
      rewardedToday: true,
      lastResult: "present",
      checkedAt: NOON.toISOString(),
    });
    // bio — отдельное задание: оно не начато
    expect(result.view.tasks.find((task) => task.kind === "bio")).toMatchObject({ started: false, rewardedToday: false });
  });

  it("bio платит своей наградой и своим источником", async () => {
    const { service, wallet } = setup();
    const result = await service.check(PLAYER, "bio", NOON);
    expect(result.credited).toEqual({ coins: 0, gems: 3, shards: 0 });
    expect(grantsOf(wallet)).toEqual([["gems", 3, "task_reward", "bot-mention:bio", `bot-mention:${ME}:bio:${TODAY}:gems`]]);
  });

  it("суточный потолок кошелька: credited — сколько легло, а не сколько назначено", async () => {
    const { service, wallet } = setup();
    wallet.caps.set("coins", 40);
    const result = await service.check(PLAYER, "name", NOON);
    expect(result.credited).toEqual({ coins: 40, gems: 0, shards: 2 });
  });

  it("повторная проверка в те же сутки — done_today: площадку не спрашивает, второй награды нет", async () => {
    const { service, wallet, port } = setup();
    await service.check(PLAYER, "name", NOON);
    const again = await service.check(PLAYER, "name", new Date(NOON.getTime() + 5 * HOUR));

    expect(again.outcome).toBe("done_today");
    expect(again.credited).toEqual(NONE);
    expect(again.view.tasks.find((task) => task.kind === "name")).toMatchObject({ rewardedToday: true, streak: 1 });
    expect(port.calls).toHaveLength(1);
    expect(wallet.grants).toHaveLength(2);
  });

  it.each(["absent", "hidden"] as const)("%s: награды нет, исход записан, сутки отмечены проверенными", async (finding) => {
    const { service, wallet, repository, port } = setup();
    port.answer = () => found({ name: finding });
    const result = await service.check(PLAYER, "name", NOON);

    expect(result.outcome).toBe(finding);
    expect(result.credited).toEqual(NONE);
    expect(wallet.grants).toEqual([]);
    expect(repository.row(ME, "name")).toMatchObject({ lastResult: finding, checkedDay: TODAY, checkedAt: NOON, lastDay: null, streak: 0, rewardedDays: 0 });
    expect(result.view.tasks.find((task) => task.kind === "name")).toMatchObject({ lastResult: finding, rewardedToday: false, started: true });
  });

  it("unavailable от площадки: награды нет, исход записан", async () => {
    const { service, wallet, repository, port } = setup();
    port.answer = () => ({ status: "unavailable", reason: "403" });
    const result = await service.check(PLAYER, "name", NOON);

    expect(result.outcome).toBe("unavailable");
    expect(wallet.grants).toEqual([]);
    expect(repository.row(ME, "name")).toMatchObject({ lastResult: "unavailable", checkedDay: TODAY });
  });

  it("порт не вернул запрошенный вид: это unavailable, а не награда", async () => {
    const { service, wallet, repository, port } = setup();
    port.answer = () => found({});
    const result = await service.check(PLAYER, "name", NOON);
    expect(result.outcome).toBe("unavailable");
    expect(wallet.grants).toEqual([]);
    expect(repository.row(ME, "name")).toMatchObject({ lastResult: "unavailable" });
  });

  it("можно проверить снова в те же сутки, если награды ещё не было: вписал юзернейм днём — не потерял сутки", async () => {
    const { service, wallet, port } = setup();
    port.answer = () => found({ name: "absent" });
    expect((await service.check(PLAYER, "name", NOON)).outcome).toBe("absent");
    port.answer = () => found({ name: "present" });
    const later = await service.check(PLAYER, "name", new Date(NOON.getTime() + 3 * HOUR));
    expect(later.outcome).toBe("present");
    expect(later.credited).toEqual({ coins: 100, gems: 0, shards: 2 });
    expect(wallet.grants).toHaveLength(2);
  });

  it("retry: награды нет, checked_day не двигается, пауза держится — следующая проверка отвечает retry без вызова порта", async () => {
    const { service, wallet, repository, port, redis } = setup();
    port.answer = () => ({ status: "retry", afterSec: 30 });
    const first = await service.check(PLAYER, "name", NOON);

    expect(first.outcome).toBe("retry");
    expect(first.credited).toEqual(NONE);
    expect(wallet.grants).toEqual([]);
    expect(repository.row(ME, "name")).toMatchObject({ checkedDay: null, lastResult: null });
    expect(await redis.pttl("bot-mention:pause")).toBe(30_000);

    port.answer = () => found({ name: "present" });
    const second = await service.check(PLAYER, "name", NOON);
    expect(second.outcome).toBe("retry");
    expect(port.calls).toHaveLength(1);
    // пауза общая: и для другого вида, и для другого игрока
    const bio = await service.check(PLAYER, "bio", NOON);
    expect(bio.outcome).toBe("retry");
    expect(port.calls).toHaveLength(1);

    redis.advance(31_000);
    const third = await service.check(PLAYER, "name", NOON);
    expect(third.outcome).toBe("present");
    expect(port.calls).toHaveLength(2);
  });

  it("новая пауза не укорачивает действующую", async () => {
    const { service, port, redis } = setup();
    port.answer = () => ({ status: "retry", afterSec: 120 });
    await service.check(PLAYER, "name", NOON);
    redis.advance(10_000);
    // Другая реплика получила 429 с короткой паузой: действующая длинная не укорачивается.
    await new BotMentionBackoff(redis as never).hold(5);
    expect(await redis.pttl("bot-mention:pause")).toBe(110_000);
  });

  it("исключение порта — это retry на несколько секунд: ошибка не уходит игроку, в лог идёт только её имя, без текста", async () => {
    const { service, port, redis, wallet } = setup();
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    port.answer = () => {
      throw new Error("Иван @game_bot из чата");
    };
    const result = await service.check(PLAYER, "name", NOON);

    expect(result.outcome).toBe("retry");
    expect(wallet.grants).toEqual([]);
    expect(await redis.pttl("bot-mention:pause")).toBe(5_000);
    const lines = warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(lines).toEqual([
      { module: "bot-mention", event: "bot_mention_port_failed", platform: "telegram", reason: "Error" },
      { module: "bot-mention", event: "bot_mention_paused", afterSec: 5 },
    ]);
    expect(JSON.stringify(lines)).not.toContain("Иван");
  });

  it("id игрока длиннее 15 цифр или не число (аккаунт разработчика): порт не зовётся, исход unavailable", async () => {
    for (const platformUserId of ["12345678901234567890", "dev-1a2b", "1234567890123456"]) {
      const { service, port, repository, wallet } = setup();
      const result = await service.check({ ...PLAYER, platformUserId }, "name", NOON);
      expect(result.outcome, platformUserId).toBe("unavailable");
      expect(port.calls, platformUserId).toEqual([]);
      expect(wallet.grants).toEqual([]);
      expect(repository.row(ME, "name"), platformUserId).toMatchObject({ lastResult: "unavailable", checkedDay: TODAY });
    }
  });

  it("id ровно из 15 цифр уходит в порт строкой, как есть", async () => {
    const { service, port } = setup();
    await service.check({ ...PLAYER, platformUserId: "999999999999999" }, "name", NOON);
    expect(port.calls).toEqual([{ id: "999999999999999", kinds: ["name"] }]);
  });

  it("серия: награда каждые сутки подряд растёт на единицу, награда за сутки не зависит от серии", async () => {
    const { service, wallet, repository } = setup();
    const results = [];
    for (const offset of [0, 1, 2]) results.push(await service.check(PLAYER, "name", dayOf(NOON, offset)));

    expect(results.map((result) => result.credited)).toEqual([results[0]?.credited, results[0]?.credited, results[0]?.credited]);
    expect(results.map((result) => result.view.tasks.find((task) => task.kind === "name")?.streak)).toEqual([1, 2, 3]);
    expect(wallet.grants.map((grant) => grant.idempotencyKey).filter((key) => key.endsWith(":coins"))).toEqual([
      `bot-mention:${ME}:name:2026-10-21:coins`,
      `bot-mention:${ME}:name:2026-10-22:coins`,
      `bot-mention:${ME}:name:2026-10-23:coins`,
    ]);
    expect(repository.row(ME, "name")).toMatchObject({ streak: 3, bestStreak: 3, rewardedDays: 3 });
  });

  it("пропуск суток обнуляет серию без штрафа: лучшая серия и полученное остаются", async () => {
    const { service, wallet, repository } = setup();
    await service.check(PLAYER, "name", dayOf(NOON, 0));
    await service.check(PLAYER, "name", dayOf(NOON, 1));
    // 23.10 игрока в игре не было; 24.10 юзернейм стоит
    const afterGap = await service.check(PLAYER, "name", dayOf(NOON, 3));

    expect(afterGap.view.tasks.find((task) => task.kind === "name")).toMatchObject({ streak: 1, bestStreak: 2 });
    expect(repository.row(ME, "name")).toMatchObject({ streak: 1, bestStreak: 2, rewardedDays: 3 });
    expect(wallet.grants.filter((grant) => grant.resource === "coins")).toHaveLength(3);
  });

  it("убрал юзернейм: награды за сутки нет, полученное не отнимается, на экране серия ещё живёт до конца суток и обнуляется на следующие", async () => {
    const { service, wallet, repository, port } = setup();
    await service.check(PLAYER, "name", dayOf(NOON, 0));
    port.answer = () => found({ name: "absent" });
    const removed = await service.check(PLAYER, "name", dayOf(NOON, 1));

    expect(removed.outcome).toBe("absent");
    expect(removed.credited).toEqual(NONE);
    expect(removed.view.tasks.find((task) => task.kind === "name")).toMatchObject({ streak: 1, bestStreak: 1, rewardedToday: false, lastResult: "absent" });
    const next = (await service.view(PLAYER, dayOf(NOON, 2))).tasks.find((task) => task.kind === "name");
    expect(next).toMatchObject({ streak: 0, bestStreak: 1, rewardedToday: false });
    expect(wallet.grants.filter((grant) => grant.resource === "coins")).toHaveLength(1);
    expect(repository.row(ME, "name")).toMatchObject({ rewardedDays: 1, lastDay: TODAY });
  });

  it("закрытое bio — hidden, а не «убрал»: серия не сбрасывается раньше срока, награды нет", async () => {
    const { service, port, repository } = setup();
    await service.check(PLAYER, "bio", dayOf(NOON, 0));
    port.answer = () => found({ bio: "hidden" });
    const hidden = await service.check(PLAYER, "bio", dayOf(NOON, 1));
    expect(hidden.outcome).toBe("hidden");
    expect(hidden.credited).toEqual(NONE);
    expect(repository.row(ME, "bio")).toMatchObject({ lastResult: "hidden", streak: 1, lastDay: TODAY });
  });

  it("сбой кошелька на втором ресурсе: сутки не засчитаны, повтор доплатит недостающее и вернёт полную награду", async () => {
    const { service, wallet, repository } = setup();
    wallet.failOn = "shard_common";
    await expect(service.check(PLAYER, "name", NOON)).rejects.toThrow("база недоступна");
    expect(repository.row(ME, "name")).toMatchObject({ lastDay: null, rewardedDays: 0, streak: 0 });
    expect(wallet.grants.map((grant) => grant.resource)).toEqual(["coins"]);

    const retry = await service.check(PLAYER, "name", NOON);
    expect(retry.outcome).toBe("present");
    expect(retry.credited).toEqual({ coins: 100, gems: 0, shards: 2 });
    // монеты не легли второй раз — тот же ключ
    expect(wallet.grants.map((grant) => grant.resource)).toEqual(["coins", "shard_common"]);
    expect(repository.row(ME, "name")).toMatchObject({ rewardedDays: 1, streak: 1 });
  });

  it("пять проверок разом: награждены сутки один раз, серия выросла на единицу", async () => {
    const { service, wallet, repository } = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => service.check(PLAYER, "name", NOON)));

    expect(results.filter((result) => result.outcome === "present")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "done_today")).toHaveLength(4);
    expect(results.filter((result) => result.outcome === "present")[0]?.credited).toEqual({ coins: 100, gems: 0, shards: 2 });
    expect(wallet.grants).toHaveLength(2);
    expect(repository.row(ME, "name")).toMatchObject({ rewardedDays: 1, streak: 1, bestStreak: 1 });
  });

  it("день награды в логе, без текстов: bot_mention_day_rewarded с аккаунтом, видом и серией", async () => {
    const { service } = setup();
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    await service.check(PLAYER, "name", NOON);
    await service.check(PLAYER, "name", NOON);

    const lines = log.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(lines).toEqual([{ module: "bot-mention", event: "bot_mention_day_rewarded", accountId: ME, kind: "name", streak: 1 }]);
  });

  it("виды заданий — имя и bio, и ничего больше", () => {
    expect([...BOT_MENTION_KINDS]).toEqual(["name", "bio"]);
    expect(containsMention("Иван @Game_Bot", "game_bot")).toBe(true);
    expect(containsMention("Иван game_bot", "game_bot")).toBe(false);
  });
});
