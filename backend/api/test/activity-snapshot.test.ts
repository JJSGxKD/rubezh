import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { daysToClose, pickRecord, windowOf, type ActivityWindow } from "../src/modules/admin-notify/activity-snapshot.js";
import { ActivitySnapshotJob } from "../src/modules/admin-notify/activity-snapshot.job.js";
import type { ActivitySnapshotRepository } from "../src/modules/admin/admin-all-time.repository.js";

/**
 * Суточные снимки аудитории (tasks/T-0203): какие сутки закрыть, окна DAU/WAU/MAU
 * по московской полуночи, рекорд с датой, и проход задания — по порядку, с
 * остановкой на первой ошибке и без двойной записи.
 */

const at = (iso: string) => new Date(iso);

describe("daysToClose: какие сутки закрыть", () => {
  const NOW = at("2026-10-04T12:00:00+03:00");

  it("пустая таблица: от суток первой сессии до вчерашних включительно", () => {
    expect(daysToClose(null, at("2026-10-01T10:00:00+03:00"), NOW)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("есть записи: со следующих за последней", () => {
    expect(daysToClose("2026-10-02", at("2026-09-01T10:00:00+03:00"), NOW)).toEqual(["2026-10-03"]);
  });

  it("последняя запись — вчерашняя, нечего закрывать", () => {
    expect(daysToClose("2026-10-03", at("2026-09-01T10:00:00+03:00"), NOW)).toEqual([]);
  });

  it("записей нет и сессий нет — пусто, а не вся история нулями", () => {
    expect(daysToClose(null, null, NOW)).toEqual([]);
  });

  it("потолок за один проход: первые сутки по порядку, остальное доберёт следующий проход", () => {
    expect(daysToClose(null, at("2026-09-20T10:00:00+03:00"), NOW, 2)).toEqual(["2026-09-20", "2026-09-21"]);
  });

  it("потолок по умолчанию — 400 суток", () => {
    const days = daysToClose(null, at("2024-01-01T10:00:00+03:00"), NOW);
    expect(days).toHaveLength(400);
    expect(days[0]).toBe("2024-01-01");
    expect(days.at(-1)).toBe("2025-02-03");
  });

  it("сутки первой сессии — по Москве: 00:30 первого числа — уже первое, 23:59 последнего — ещё последнее", () => {
    expect(daysToClose(null, at("2026-09-30T21:30:00Z"), NOW)[0]).toBe("2026-10-01");
    expect(daysToClose(null, at("2026-09-30T20:59:00Z"), NOW)[0]).toBe("2026-09-30");
  });

  it("сразу после московской полуночи вчерашними считаются только что закончившиеся сутки", () => {
    const justAfter = at("2026-10-04T00:05:00+03:00");
    expect(daysToClose("2026-10-01", null, justAfter)).toEqual(["2026-10-02", "2026-10-03"]);
  });

  it("за минуту до полуночи вчерашние — ещё предыдущие: сегодняшние сутки не закрываются", () => {
    const justBefore = at("2026-10-03T23:59:00+03:00");
    expect(daysToClose("2026-10-01", null, justBefore)).toEqual(["2026-10-02"]);
  });

  it("последняя запись из будущего (часы, ручная правка) — пусто, а не провал назад", () => {
    expect(daysToClose("2026-10-09", null, NOW)).toEqual([]);
    expect(daysToClose(null, at("2026-10-09T10:00:00+03:00"), NOW)).toEqual([]);
  });

  it("граница месяца и года проходится календарём, а не по 30 дней", () => {
    expect(daysToClose("2026-12-30", null, at("2027-01-03T12:00:00+03:00"))).toEqual(["2026-12-31", "2027-01-01", "2027-01-02"]);
  });
});

describe("windowOf: окно суток по московской полуночи", () => {
  it("одни сутки: от полуночи до следующей", () => {
    expect(windowOf("2026-10-07", 1)).toEqual({ from: at("2026-10-06T21:00:00Z"), to: at("2026-10-07T21:00:00Z") });
  });

  it("семь суток, заканчивающихся этими включительно: с 1 октября 00:00 до 8 октября 00:00", () => {
    expect(windowOf("2026-10-07", 7)).toEqual({ from: at("2026-09-30T21:00:00Z"), to: at("2026-10-07T21:00:00Z") });
  });

  it("тридцать суток через границу месяца", () => {
    expect(windowOf("2026-10-10", 30)).toEqual({ from: at("2026-09-10T21:00:00Z"), to: at("2026-10-10T21:00:00Z") });
  });

  it("тридцать суток через границу года", () => {
    expect(windowOf("2027-01-05", 30)).toEqual({ from: at("2026-12-06T21:00:00Z"), to: at("2027-01-05T21:00:00Z") });
  });

  it("окна вложены друг в друга и кончаются одним моментом", () => {
    const [day, week, month] = ([1, 7, 30] as const).map((length) => windowOf("2026-10-20", length));
    expect(day?.to.getTime()).toBe(week?.to.getTime());
    expect(week?.to.getTime()).toBe(month?.to.getTime());
    expect(week?.from.getTime()).toBeLessThan(day?.from.getTime() ?? 0);
    expect(month?.from.getTime()).toBeLessThan(week?.from.getTime() ?? 0);
  });
});

describe("pickRecord: рекорд с датой", () => {
  it("максимум по значению", () => {
    expect(
      pickRecord([
        { day: "2026-10-01", value: 5 },
        { day: "2026-10-02", value: 12 },
        { day: "2026-10-03", value: 7 },
      ]),
    ).toEqual({ value: 12, day: "2026-10-02" });
  });

  it("при равенстве — более ранние сутки, в каком бы порядке ни пришли", () => {
    const points = [
      { day: "2026-10-03", value: 9 },
      { day: "2026-10-01", value: 9 },
      { day: "2026-10-02", value: 9 },
    ];
    expect(pickRecord(points)).toEqual({ value: 9, day: "2026-10-01" });
    expect(pickRecord([...points].reverse())).toEqual({ value: 9, day: "2026-10-01" });
  });

  it("пусто — рекорда нет", () => {
    expect(pickRecord([])).toBeNull();
  });

  it("не меняет входной список", () => {
    const points = [
      { day: "2026-10-02", value: 1 },
      { day: "2026-10-01", value: 2 },
    ];
    pickRecord(points);
    expect(points.map((point) => point.day)).toEqual(["2026-10-02", "2026-10-01"]);
  });
});

/** Хранилище снимков в памяти: окно 1/7/30 суток даёт 10/70/300, чтобы по числам было видно, какое окно спросили. */
class FakeSnapshots implements ActivitySnapshotRepository {
  readonly rows = new Map<string, { dau: number; wau: number; mau: number }>();
  readonly asked: ActivityWindow[] = [];
  first: Date | null = null;
  failOnDay: string | null = null;
  conflictOn = new Set<string>();

  async lastClosedDay(): Promise<string | null> {
    return [...this.rows.keys()].sort().at(-1) ?? null;
  }
  async firstSessionAt(): Promise<Date | null> {
    return this.first;
  }
  async activeIn(window: ActivityWindow): Promise<number> {
    this.asked.push(window);
    const days = Math.round((window.to.getTime() - window.from.getTime()) / 86_400_000);
    // Сутки закрываемого дня — по концу окна: полночь следующих минус сутки.
    const day = new Date(window.to.getTime() - 86_400_000 + 3 * 3_600_000).toISOString().slice(0, 10);
    if (this.failOnDay === day) throw new Error("база не ответила");
    return days * 10;
  }
  async insertDay(day: string, dau: number, wau: number, mau: number): Promise<boolean> {
    if (this.conflictOn.has(day) || this.rows.has(day)) return false;
    this.rows.set(day, { dau, wau, mau });
    return true;
  }
}

describe("проход задания снимка", () => {
  const NOW = at("2026-10-04T00:20:00+03:00");
  const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://user:secret@localhost:5432/db" } as NodeJS.ProcessEnv);
  let log: MockInstance;
  let warn: MockInstance;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lines = (spy: MockInstance): Record<string, unknown>[] => spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

  it("пустая таблица: строки за каждые сутки от первой сессии по порядку, три окна на сутки", async () => {
    const repository = new FakeSnapshots();
    repository.first = at("2026-10-01T10:00:00+03:00");
    const closed = await new ActivitySnapshotJob(config, repository).closeDays(NOW);

    expect(closed).toBe(3);
    expect([...repository.rows.keys()]).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(repository.rows.get("2026-10-02")).toEqual({ dau: 10, wau: 70, mau: 300 });
    expect(repository.asked).toHaveLength(9);
    expect(lines(log)).toEqual([expect.objectContaining({ event: "activity_snapshot_done", closed: 3 })]);
  });

  it("сутки без сессий — строка с нулями, а не дыра", async () => {
    const repository = new FakeSnapshots();
    repository.first = at("2026-10-01T10:00:00+03:00");
    vi.spyOn(repository, "activeIn").mockResolvedValue(0);
    await new ActivitySnapshotJob(config, repository).closeDays(NOW);
    expect(repository.rows.get("2026-10-02")).toEqual({ dau: 0, wau: 0, mau: 0 });
    expect(repository.rows.size).toBe(3);
  });

  it("повторный проход ничего не пишет и не считает", async () => {
    const repository = new FakeSnapshots();
    repository.first = at("2026-10-01T10:00:00+03:00");
    const job = new ActivitySnapshotJob(config, repository);
    await job.closeDays(NOW);
    const asked = repository.asked.length;
    expect(await job.closeDays(NOW)).toBe(0);
    expect(repository.asked).toHaveLength(asked);
    expect(repository.rows.size).toBe(3);
  });

  it("сбой суток останавливает проход: дальше окно ушло бы дырой; в лог — одна JSON-строка с сутками и причиной", async () => {
    const repository = new FakeSnapshots();
    repository.first = at("2026-10-01T10:00:00+03:00");
    repository.failOnDay = "2026-10-02";
    const closed = await new ActivitySnapshotJob(config, repository).closeDays(NOW);

    expect(closed).toBe(1);
    expect([...repository.rows.keys()]).toEqual(["2026-10-01"]);
    expect(lines(warn)).toEqual([expect.objectContaining({ event: "activity_snapshot_failed", day: "2026-10-02", reason: "база не ответила" })]);
    expect(lines(log)).toEqual([expect.objectContaining({ event: "activity_snapshot_done", closed: 1 })]);
  });

  it("следующий проход после сбоя продолжает с упавших суток, а не с начала", async () => {
    const repository = new FakeSnapshots();
    repository.first = at("2026-10-01T10:00:00+03:00");
    repository.failOnDay = "2026-10-02";
    const job = new ActivitySnapshotJob(config, repository);
    await job.closeDays(NOW);

    repository.failOnDay = null;
    repository.asked.length = 0;
    expect(await job.closeDays(NOW)).toBe(2);
    expect([...repository.rows.keys()]).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(repository.asked).toHaveLength(6);
  });

  it("сутки уже записала соседняя реплика: вставка отказала без ошибки, в «закрыто» они не входят", async () => {
    const repository = new FakeSnapshots();
    repository.first = at("2026-10-01T10:00:00+03:00");
    repository.conflictOn.add("2026-10-02");
    const closed = await new ActivitySnapshotJob(config, repository).closeDays(NOW);
    expect(closed).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("закрывать нечего — проход всё равно пишет итог с нулём", async () => {
    const repository = new FakeSnapshots();
    await new ActivitySnapshotJob(config, repository).closeDays(NOW);
    expect(lines(log)).toEqual([expect.objectContaining({ event: "activity_snapshot_done", closed: 0 })]);
  });

  it("первая сессия спрашивается, только когда таблица пуста", async () => {
    const repository = new FakeSnapshots();
    repository.rows.set("2026-10-02", { dau: 1, wau: 1, mau: 1 });
    const first = vi.spyOn(repository, "firstSessionAt");
    await new ActivitySnapshotJob(config, repository).closeDays(NOW);
    expect(first).not.toHaveBeenCalled();
  });

  describe("отставание при старте API", () => {
    const job = (repository: FakeSnapshots) => new ActivitySnapshotJob(config, repository);

    it("таблица пуста, сессии есть — догонять", async () => {
      const repository = new FakeSnapshots();
      repository.first = at("2026-10-03T10:00:00+03:00");
      expect(await job(repository).lagging(NOW)).toBe(true);
    });

    it("таблица пуста и сессий нет — нечего", async () => {
      expect(await job(new FakeSnapshots()).lagging(NOW)).toBe(false);
    });

    it("не хватает только вчерашних — это ночь до задания, не отставание", async () => {
      const repository = new FakeSnapshots();
      repository.rows.set("2026-10-02", { dau: 1, wau: 1, mau: 1 });
      expect(await job(repository).lagging(NOW)).toBe(false);
    });

    it("не хватает двух суток и больше — отставание", async () => {
      const repository = new FakeSnapshots();
      repository.rows.set("2026-10-01", { dau: 1, wau: 1, mau: 1 });
      expect(await job(repository).lagging(NOW)).toBe(true);
    });

    it("записано по вчерашние — отставания нет", async () => {
      const repository = new FakeSnapshots();
      repository.rows.set("2026-10-03", { dau: 1, wau: 1, mau: 1 });
      expect(await job(repository).lagging(NOW)).toBe(false);
    });
  });

  it("включено там же, где остальные задания: нужен адрес базы", () => {
    const withoutDatabase = loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(new ActivitySnapshotJob(config, new FakeSnapshots()).enabled).toBe(true);
    expect(new ActivitySnapshotJob(withoutDatabase, new FakeSnapshots()).enabled).toBe(false);
  });
});
