import "reflect-metadata";
import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEED_KINDS, type FeedEvent } from "../src/modules/feed/feed-events.js";
import { FEED_WINDOW_MS, feedEventsOf, visibleEvents } from "../src/modules/feed/feed-rules.js";
import { FeedService } from "../src/modules/feed/feed.service.js";
import type { FeedRepository } from "../src/modules/feed/feed.repository.js";
import type { RestrictionKind } from "../src/modules/restrictions/restriction-catalog.js";
import type { Difficulty } from "../src/modules/runs/run-rules.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Лента живых событий без баз (tasks/T-0174): правила на чистых функциях,
 * сервис — на подменах репозитория и ограничений. Часы зафиксированы: время
 * приходит в `view(now)`, а предупреждение раз в минуту идёт по системным
 * часам, которые тест двигает сам.
 */

const NOW = new Date("2026-11-04T12:00:00.000Z");
const HOUR = 3_600_000;
const SECOND = 1_000;
const ALICE = "3f6b1a52-8c1e-4d6a-9b6e-1d2c3b4a5f61";
const BOB = "3f6b1a52-8c1e-4d6a-9b6e-1d2c3b4a5f62";
const CAROL = "3f6b1a52-8c1e-4d6a-9b6e-1d2c3b4a5f63";

function recorded(patch: Partial<RecordedRun> = {}): RecordedRun {
  return {
    runId: "run-1",
    accountId: ALICE,
    difficulty: "hard",
    outcome: "died",
    survivalSec: 700,
    level: 10,
    enemiesKilled: 300,
    startingWeaponId: "knife",
    weapons: [],
    boosts: [],
    xpCollected: null,
    counters: null,
    deathCause: null,
    cheats: false,
    continues: 0,
    ranked: true,
    verdict: "ok",
    reasons: [],
    finishedAt: NOW,
    ...patch,
  };
}

function event(patch: Partial<FeedEvent> = {}): FeedEvent {
  return { id: "run-1:long_run", kind: "long_run", accountId: ALICE, atMs: NOW.getTime() - HOUR, seconds: 700, ...patch };
}

describe("feedEventsOf: что из забега попадает в ленту", () => {
  const rules = { longRunSec: 600 };

  it("нерейтинговый забег — пусто", () => {
    expect(feedEventsOf(recorded({ ranked: false }), rules, true)).toEqual([]);
  });

  it("рейтинговый, но вердикт не ok — пусто", () => {
    expect(feedEventsOf(recorded({ verdict: "suspicious" }), rules, true)).toEqual([]);
    expect(feedEventsOf(recorded({ verdict: "rejected" }), rules, true)).toEqual([]);
  });

  it("с читами — пусто", () => {
    expect(feedEventsOf(recorded({ cheats: true }), rules, true)).toEqual([]);
  });

  it("599 с при пороге 600 — без long_run, 600 — long_run со временем забега", () => {
    expect(feedEventsOf(recorded({ survivalSec: 599 }), rules, false)).toEqual([]);

    const events = feedEventsOf(recorded({ survivalSec: 600 }), rules, false);

    expect(events).toEqual([{ id: "run-1:long_run", kind: "long_run", accountId: ALICE, atMs: NOW.getTime(), seconds: 600 }]);
  });

  it("рекорд недели — week_record с тем же временем, даже короткий забег", () => {
    const events = feedEventsOf(recorded({ survivalSec: 300 }), rules, true);

    expect(events).toEqual([{ id: "run-1:week_record", kind: "week_record", accountId: ALICE, atMs: NOW.getTime(), seconds: 300 }]);
  });

  it("оба условия — два события с разными id", () => {
    const events = feedEventsOf(recorded({ survivalSec: 900 }), rules, true);

    expect(events.map((item) => item.kind).sort()).toEqual(["long_run", "week_record"]);
    expect(new Set(events.map((item) => item.id)).size).toBe(2);
  });

  it("порог берётся из правил, а не зашит", () => {
    expect(feedEventsOf(recorded({ survivalSec: 100 }), { longRunSec: 60 }, false)).toHaveLength(1);
  });

  it("виды схемы: четыре, босс и сундук читаются, но здесь не создаются", () => {
    expect([...FEED_KINDS]).toEqual(["long_run", "week_record", "boss", "chest"]);
  });
});

describe("visibleEvents: что видит игрок", () => {
  const base = { nowMs: NOW.getTime(), hidden: new Set<string>(), perPlayer: 2, limit: 20 };

  it("старше суток отброшено, ровно 24 ч назад — ещё видно", () => {
    const events = [event({ id: "old", atMs: NOW.getTime() - FEED_WINDOW_MS - 1 }), event({ id: "edge", atMs: NOW.getTime() - FEED_WINDOW_MS })];

    expect(visibleEvents(events, base).map((item) => item.id)).toEqual(["edge"]);
  });

  it("окно — ровно сутки", () => {
    expect(FEED_WINDOW_MS).toBe(86_400_000);
  });

  it("скрытый аккаунт отброшен", () => {
    const events = [event({ id: "a" }), event({ id: "b", accountId: BOB })];

    expect(visibleEvents(events, { ...base, hidden: new Set([BOB]) }).map((item) => item.id)).toEqual(["a"]);
  });

  it("три события игрока при perPlayer 2 — два самых свежих", () => {
    const events = [
      event({ id: "a", atMs: NOW.getTime() - 3 * HOUR }),
      event({ id: "b", atMs: NOW.getTime() - 1 * HOUR }),
      event({ id: "c", atMs: NOW.getTime() - 2 * HOUR }),
    ];

    expect(visibleEvents(events, base).map((item) => item.id)).toEqual(["b", "c"]);
  });

  it("сортировка от свежих к старым, как бы ни пришли", () => {
    const events = [
      event({ id: "a", accountId: ALICE, atMs: NOW.getTime() - 3 * HOUR }),
      event({ id: "b", accountId: BOB, atMs: NOW.getTime() - 1 * HOUR }),
      event({ id: "c", accountId: CAROL, atMs: NOW.getTime() - 2 * HOUR }),
    ];

    expect(visibleEvents(events, base).map((item) => item.id)).toEqual(["b", "c", "a"]);
  });

  it("limit режет после отбора", () => {
    const events = [
      event({ id: "a", accountId: ALICE, atMs: NOW.getTime() - 3 * HOUR }),
      event({ id: "b", accountId: BOB, atMs: NOW.getTime() - 1 * HOUR }),
      event({ id: "c", accountId: CAROL, atMs: NOW.getTime() - 2 * HOUR }),
    ];

    expect(visibleEvents(events, { ...base, limit: 2 }).map((item) => item.id)).toEqual(["b", "c"]);
  });

  it("событие из будущего (часы разошлись) не отбрасывается как старое", () => {
    expect(visibleEvents([event({ id: "f", atMs: NOW.getTime() + 5 * SECOND })], base)).toHaveLength(1);
  });

  it("пусто на входе — пусто на выходе", () => {
    expect(visibleEvents([], base)).toEqual([]);
  });
});

/** Репозиторий в памяти с теми же обещаниями, что у настоящего. */
class FakeFeedRepository implements FeedRepository {
  readonly events: FeedEvent[] = [];
  readonly names = new Map<string, string>();
  readonly weekTop = new Map<string, number>();
  readonly bumps: { seasonKey: string; difficulty: Difficulty; survivalSec: number }[] = [];
  /** подмена ответа `bumpWeekTop`; не задано — честное «записать, если больше» */
  bumpResult: number | null = null;
  skipped = 0;
  recentCalls = 0;
  namesCalls = 0;
  failAdd = false;
  failRecent = false;

  async add(events: readonly FeedEvent[]): Promise<void> {
    if (this.failAdd) throw new Error("redis down");
    for (const item of events) if (!this.events.some((known) => known.id === item.id)) this.events.push(item);
  }

  async recent(sinceMs: number, cap: number): Promise<{ events: FeedEvent[]; skipped: number }> {
    this.recentCalls += 1;
    if (this.failRecent) throw new Error("redis down");
    const events = this.events.filter((item) => item.atMs >= sinceMs).sort((a, b) => b.atMs - a.atMs).slice(0, cap);
    return { events, skipped: this.skipped };
  }

  async bumpWeekTop(seasonKey: string, difficulty: Difficulty, survivalSec: number): Promise<number> {
    this.bumps.push({ seasonKey, difficulty, survivalSec });
    if (this.bumpResult !== null) return this.bumpResult;
    const key = `${seasonKey}:${difficulty}`;
    const previous = this.weekTop.get(key);
    if (previous === undefined) {
      this.weekTop.set(key, survivalSec);
      return -1;
    }
    if (survivalSec > previous) {
      this.weekTop.set(key, survivalSec);
      return previous;
    }
    return 0;
  }

  async namesOf(accountIds: readonly string[]): Promise<Map<string, string>> {
    this.namesCalls += 1;
    return new Map(accountIds.flatMap((id) => (this.names.has(id) ? [[id, this.names.get(id) as string] as const] : [])));
  }
}

const START_DATE = 20_260_105;

function build(settings: Record<string, number> = {}, seasons = true) {
  const repository = new FakeFeedRepository();
  repository.names.set(ALICE, "Алиса");
  repository.names.set(BOB, "Боб");
  repository.names.set(CAROL, "Кэрол");
  const panel = panelSettings({ ...(seasons ? { [SETTINGS.seasonsStartDate.key]: START_DATE } : {}), ...settings });
  const schedule = new SeasonSchedule(panel);
  const hooks = new RunsHooks();
  const hidden: Record<string, string[]> = {};
  const asked: RestrictionKind[] = [];
  const restrictions = {
    restrictedAccounts: vi.fn(async (kind: RestrictionKind) => {
      asked.push(kind);
      return hidden[kind] ?? [];
    }),
  };
  const service = new FeedService(repository, schedule, hooks, restrictions as never, panel);
  service.onModuleInit();
  return { repository, service, hooks, hidden, asked, panel };
}

describe("запись: слушатель забегов", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("слушатель подписан на запись забега", async () => {
    const { hooks, repository } = build();

    await hooks.emit(recorded({ survivalSec: 650 }));

    expect(repository.events.map((item) => item.kind)).toContain("long_run");
  });

  it("первый рейтинговый забег недели на пустой таблице: week_record нет (bump вернул -1)", async () => {
    const { service, repository } = build();
    repository.bumpResult = -1;

    await service.recorded(recorded({ survivalSec: 300 }));

    expect(repository.events).toEqual([]);
    expect(repository.bumps).toEqual([{ seasonKey: "2026-11-02", difficulty: "hard", survivalSec: 300 }]);
  });

  it("прежнее 400, забег 450 — рекорд недели записан", async () => {
    const { service, repository } = build();
    repository.bumpResult = 400;

    await service.recorded(recorded({ survivalSec: 450 }));

    expect(repository.events).toEqual([{ id: "run-1:week_record", kind: "week_record", accountId: ALICE, atMs: NOW.getTime(), seconds: 450 }]);
  });

  it("забег 400 при прежних 400 — не рекорд", async () => {
    const { service, repository } = build();
    repository.bumpResult = 400;

    await service.recorded(recorded({ survivalSec: 400 }));

    expect(repository.events).toEqual([]);
  });

  it("лидера ведёт сама лента: второй забег длиннее первого — рекорд, короче — нет", async () => {
    const { service, repository } = build();

    await service.recorded(recorded({ runId: "r1", survivalSec: 300 }));
    await service.recorded(recorded({ runId: "r2", survivalSec: 350 }));
    await service.recorded(recorded({ runId: "r3", survivalSec: 340 }));

    expect(repository.events.map((item) => item.id)).toEqual(["r2:week_record"]);
  });

  it("сезонов нет — week_record нет и лидер не ведётся, long_run есть", async () => {
    const { service, repository } = build({}, false);
    repository.bumpResult = 400;

    await service.recorded(recorded({ survivalSec: 900 }));

    expect(repository.bumps).toEqual([]);
    expect(repository.events.map((item) => item.kind)).toEqual(["long_run"]);
  });

  it("нерейтинговый, сомнительный и с читами забеги не трогают ни ленту, ни лидера недели", async () => {
    const { service, repository } = build();

    await service.recorded(recorded({ ranked: false, survivalSec: 900 }));
    await service.recorded(recorded({ verdict: "suspicious", survivalSec: 900 }));
    await service.recorded(recorded({ cheats: true, survivalSec: 900 }));

    expect(repository.events).toEqual([]);
    expect(repository.bumps).toEqual([]);
  });

  it("нерейтинговая сложность и забег раньше отсечки рейтинга — не в ленту", async () => {
    const { service, repository } = build({ [SETTINGS.ratingSinceDate.key]: 20_261_105 });

    await service.recorded(recorded({ survivalSec: 900 }));
    expect(repository.events).toEqual([]);

    await service.recorded(recorded({ survivalSec: 900, difficulty: "easy", finishedAt: new Date("2026-11-06T00:00:00Z") }));
    expect(repository.events).toEqual([]);
  });

  it("повтор того же забега не удваивает события", async () => {
    const { service, repository } = build();

    await service.recorded(recorded({ survivalSec: 700 }));
    await service.recorded(recorded({ survivalSec: 700 }));

    expect(repository.events).toHaveLength(1);
  });

  it("порог из настроек панели", async () => {
    const { service, repository } = build({ [SETTINGS.feedLongRunSec.key]: 60 });

    await service.recorded(recorded({ survivalSec: 61 }));

    expect(repository.events.map((item) => item.kind)).toEqual(["long_run"]);
  });

  it("сбой Redis при записи: слушатель не бросает, одна строка warn за минуту", async () => {
    const { service, hooks, repository } = build();
    repository.failAdd = true;

    await expect(service.recorded(recorded({ runId: "a" }))).resolves.toBeUndefined();
    await hooks.emit(recorded({ runId: "b" }));
    await hooks.emit(recorded({ runId: "c" }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ module: "feed" });
    // Ошибку слушателя не видит и шина забегов: забег от ленты не страдает.
    expect(error).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(NOW.getTime() + 61 * SECOND));
    await service.recorded(recorded({ runId: "d" }));

    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("чтение: view", () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const at = (offsetSec: number): Date => new Date(NOW.getTime() + offsetSec * SECOND);

  it("пустая лента — events: [] и интервал обновления из настроек", async () => {
    const { service } = build({ [SETTINGS.feedRefreshSec.key]: 120 });

    expect(await service.view(NOW)).toEqual({ events: [], refreshSec: 120 });
  });

  it("событие уходит с именем, ISO-временем и временем забега", async () => {
    const { service, repository } = build();
    repository.events.push(event({ id: "r9:long_run", atMs: NOW.getTime() - HOUR, seconds: 700 }));

    const view = await service.view(NOW);

    expect(view.refreshSec).toBe(300);
    expect(view.events).toEqual([
      { id: createHash("sha1").update("r9:long_run").digest("hex").slice(0, 12), kind: "long_run", name: "Алиса", at: new Date(NOW.getTime() - HOUR).toISOString(), seconds: 700 },
    ]);
  });

  it("в ответе нет accountId и сырого runId", async () => {
    const { service, repository } = build();
    repository.events.push(event({ id: "secret-run-id:long_run" }));

    const text = JSON.stringify(await service.view(NOW));

    expect(text).not.toContain(ALICE);
    expect(text).not.toContain("secret-run-id");
    expect(text).not.toContain("accountId");
    expect(text).not.toContain("runId");
  });

  it("скрытые игроки: и закрытый рейтинг, и отдельная доска; спрашиваются оба вида", async () => {
    const { service, repository, hidden, asked } = build();
    hidden.leaderboard = [ALICE];
    hidden.separate_board = [BOB];
    repository.events.push(event({ id: "a:long_run", accountId: ALICE }), event({ id: "b:long_run", accountId: BOB }), event({ id: "c:long_run", accountId: CAROL }));

    const view = await service.view(NOW);

    expect(view.events.map((item) => item.name)).toEqual(["Кэрол"]);
    expect([...asked].sort()).toEqual(["leaderboard", "separate_board"]);
  });

  it("не больше perPlayer событий игрока и не больше maxShown всего — из настроек", async () => {
    const { service, repository } = build({ [SETTINGS.feedPerPlayer.key]: 1, [SETTINGS.feedMaxShown.key]: 2 });
    repository.events.push(
      event({ id: "a1:long_run", accountId: ALICE, atMs: NOW.getTime() - 1 * HOUR }),
      event({ id: "a2:long_run", accountId: ALICE, atMs: NOW.getTime() - 2 * HOUR }),
      event({ id: "b1:long_run", accountId: BOB, atMs: NOW.getTime() - 3 * HOUR }),
      event({ id: "c1:long_run", accountId: CAROL, atMs: NOW.getTime() - 4 * HOUR }),
    );

    const view = await service.view(NOW);

    expect(view.events.map((item) => item.name)).toEqual(["Алиса", "Боб"]);
  });

  it("события старше суток не отдаются", async () => {
    const { service, repository } = build();
    repository.events.push(event({ id: "old:long_run", atMs: NOW.getTime() - FEED_WINDOW_MS - SECOND }));

    expect((await service.view(NOW)).events).toEqual([]);
  });

  it("аккаунт без имени в ответе (заблокирован или удалён) — события нет", async () => {
    const { service, repository } = build();
    repository.names.delete(BOB);
    repository.events.push(event({ id: "a:long_run", accountId: ALICE }), event({ id: "b:long_run", accountId: BOB }));

    expect((await service.view(NOW)).events.map((item) => item.name)).toEqual(["Алиса"]);
  });

  it("два параллельных view — один поход за данными", async () => {
    const { service, repository } = build();
    repository.events.push(event());

    const [first, second] = await Promise.all([service.view(NOW), service.view(NOW)]);

    expect(repository.recentCalls).toBe(1);
    expect(repository.namesCalls).toBe(1);
    expect(second).toEqual(first);
  });

  it("через 29 с — из кэша, через 31 с — пересчёт", async () => {
    const { service, repository } = build();
    repository.events.push(event());

    await service.view(NOW);
    await service.view(at(29));
    expect(repository.recentCalls).toBe(1);

    await service.view(at(31));
    expect(repository.recentCalls).toBe(2);
  });

  it("игрок на запрос не ходит в источники: десять запросов в окне кэша — один пересчёт", async () => {
    const { service, repository, asked } = build();
    repository.events.push(event());

    for (let index = 0; index < 10; index += 1) await service.view(at(index));

    expect(repository.recentCalls).toBe(1);
    expect(repository.namesCalls).toBe(1);
    expect(asked).toHaveLength(2);
  });

  it("ошибка пересчёта отдаёт прежний кэш", async () => {
    const { service, repository } = build();
    repository.events.push(event());
    const first = await service.view(NOW);

    repository.failRecent = true;

    expect(await service.view(at(31))).toEqual(first);
  });

  it("ошибка пересчёта без кэша — пустая лента, а не исключение", async () => {
    const { service, repository } = build();
    repository.failRecent = true;

    expect(await service.view(NOW)).toEqual({ events: [], refreshSec: 300 });
  });

  it("после ошибки следующий запрос не бьёт в упавший источник: ответ держится несколько секунд", async () => {
    const { service, repository } = build();
    repository.failRecent = true;

    await service.view(NOW);
    await service.view(at(1));
    expect(repository.recentCalls).toBe(1);

    repository.failRecent = false;
    await service.view(at(10));
    expect(repository.recentCalls).toBe(2);
  });

  it("имя берётся из базы на момент сборки: переименование видно после сброса кэша", async () => {
    const { service, repository } = build();
    repository.events.push(event());
    expect((await service.view(NOW)).events[0]?.name).toBe("Алиса");

    repository.names.set(ALICE, "Алисия");
    expect((await service.view(at(5))).events[0]?.name).toBe("Алиса");

    expect((await service.view(at(31))).events[0]?.name).toBe("Алисия");
    // Событие переименование не меняло: в нём нет имени.
    expect(repository.events[0]).not.toHaveProperty("name");
  });

  it("битые записи в Redis пропущены, о них — одна строка warn в минуту", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { service, repository } = build();
    repository.skipped = 3;
    repository.events.push(event());

    const view = await service.view(NOW);
    await service.view(at(31));

    expect(view.events).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ module: "feed", event: "bad_record" });
  });

  it("dropCache сбрасывает кэш этой реплики", async () => {
    const { service, repository } = build();
    repository.events.push(event());
    await service.view(NOW);

    service.dropCache();
    await service.view(at(1));

    expect(repository.recentCalls).toBe(2);
  });
});
