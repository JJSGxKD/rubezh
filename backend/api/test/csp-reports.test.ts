import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { parseCspReports } from "../src/modules/csp-reports/csp-report-parse.js";
import type { CspReportsRepository, CspStoredEntry } from "../src/modules/csp-reports/csp-reports.repository.js";
import { CspReportsService } from "../src/modules/csp-reports/csp-reports.service.js";

/**
 * Разбор отчётов браузера и сводка (Р108, tasks/T-0155): чистая логика без
 * Redis. Главное, что здесь держится, — из тела отчёта наружу выходят только
 * директива и имя хоста, всё остальное (пути, параметры, адрес страницы)
 * отбрасывается.
 */

const uriReport = (report: Record<string, unknown>): unknown => ({ "csp-report": report });

function uriBody(directive: string, blocked: string): unknown {
  return uriReport({ "effective-directive": directive, "blocked-uri": blocked });
}

describe("отчёт в формате report-uri", () => {
  it("директива из effective-directive, хост без пути и параметров", () => {
    const hits = parseCspReports(
      uriReport({
        "effective-directive": "script-src-elem",
        "violated-directive": "script-src-elem",
        "blocked-uri": "https://7ool.net/richpartners/pops/js/md5.js?x=1",
        "document-uri": "https://rubezh.gonet.fun/?tgWebAppData=секрет",
        referrer: "https://t.me/",
        "source-file": "https://rubezh.gonet.fun/assets/index.js",
        "original-policy": "default-src 'self'",
        "status-code": 200,
      }),
    );

    expect(hits).toEqual([{ directive: "script-src-elem", host: "7ool.net" }]);
  });

  it("нет effective-directive — берётся первое слово violated-directive", () => {
    const hits = parseCspReports(uriReport({ "violated-directive": "script-src 'self' https://x", "blocked-uri": "https://x.example" }));

    expect(hits).toEqual([{ directive: "script-src", host: "x.example" }]);
  });

  it("директива приводится к нижнему регистру", () => {
    const hits = parseCspReports(uriReport({ "effective-directive": "IMG-SRC", "blocked-uri": "https://a.example" }));

    expect(hits[0]?.directive).toBe("img-src");
  });

  it("неизвестная директива — other, а не чужая строка из отчёта", () => {
    const hits = parseCspReports(uriReport({ "effective-directive": "evil-directive-123", "blocked-uri": "https://a.example" }));

    expect(hits).toEqual([{ directive: "other", host: "a.example" }]);
  });

  it.each(["script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr", "img-src", "media-src", "font-src", "connect-src", "frame-src", "child-src", "worker-src", "manifest-src", "object-src", "default-src", "base-uri", "form-action", "frame-ancestors"])(
    "известная директива %s остаётся как есть",
    (directive) => {
      expect(parseCspReports(uriBody(directive, "https://a.example"))[0]?.directive).toBe(directive);
    },
  );

  it.each(["inline", "eval", "data", "blob"])("blocked-uri %s остаётся словом", (word) => {
    expect(parseCspReports(uriBody("script-src", word))).toEqual([{ directive: "script-src", host: word }]);
  });

  it.each([
    ["расширение браузера", "chrome-extension://abc/x.js"],
    ["пустая строка", ""],
    ["about", "about"],
    ["не строка (число)", 42],
    ["не строка (объект)", { a: 1 }],
    ["не строка (null)", null],
    ["IPv6 в скобках", "https://[::1]/x"],
    ["ftp", "ftp://files.example/a"],
  ])("blocked-uri: %s → other", (_name, blocked) => {
    expect(parseCspReports(uriReport({ "effective-directive": "script-src", "blocked-uri": blocked }))).toEqual([{ directive: "script-src", host: "other" }]);
  });

  it("порт и регистр отбрасываются", () => {
    const hits = parseCspReports(uriBody("connect-src", "https://CDN.Example.COM:8443/a"));

    expect(hits).toEqual([{ directive: "connect-src", host: "cdn.example.com" }]);
  });

  it("учётные данные и параметры в адресе до хоста не доходят", () => {
    const hits = parseCspReports(uriBody("img-src", "https://user:pass@ads.example/p.gif?uid=42#frag"));

    expect(hits).toEqual([{ directive: "img-src", host: "ads.example" }]);
  });

  it.each(["http://a.example/x", "ws://a.example/x", "wss://a.example/x"])("схема %s тоже даёт хост", (blocked) => {
    expect(parseCspReports(uriBody("connect-src", blocked))[0]?.host).toBe("a.example");
  });

  it("хост длиннее 253 знаков — other", () => {
    const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.example`;
    expect(long.length).toBeGreaterThan(253);

    expect(parseCspReports(uriBody("script-src", `https://${long}/x`))[0]?.host).toBe("other");
  });

  it("хост с символами вне [a-z0-9.-] — other", () => {
    expect(parseCspReports(uriBody("script-src", "https://a_b.example/x"))[0]?.host).toBe("other");
  });

  it("в результате нет ни одного поля, кроме directive и host", () => {
    const [hit] = parseCspReports(
      uriReport({
        "effective-directive": "script-src",
        "blocked-uri": "https://a.example/p?q=1",
        "document-uri": "https://page.example/?id=7",
        referrer: "https://t.me",
        "source-file": "https://s.example/a.js",
        "line-number": 5,
      }),
    );

    expect(Object.keys(hit ?? {}).sort()).toEqual(["directive", "host"]);
    expect(JSON.stringify(hit)).not.toMatch(/page\.example|t\.me|s\.example|\/p|q=1/);
  });
});

describe("отчёт в формате report-to", () => {
  const violation = (blockedURL: unknown, effectiveDirective: unknown = "script-src-elem"): unknown => ({
    type: "csp-violation",
    age: 10,
    url: "https://rubezh.gonet.fun/?tgWebAppData=секрет",
    body: { effectiveDirective, blockedURL, documentURL: "https://rubezh.gonet.fun/", referrer: "https://t.me/", sourceFile: "https://rubezh.gonet.fun/a.js" },
  });

  it("берутся записи csp-violation, остальные типы пропускаются", () => {
    const hits = parseCspReports([violation("https://a.example/x.js"), { type: "network-error", body: { blockedURL: "https://b.example" } }, violation("https://c.example/y", "img-src")]);

    expect(hits).toEqual([
      { directive: "script-src-elem", host: "a.example" },
      { directive: "img-src", host: "c.example" },
    ]);
  });

  it("слова inline и eval остаются, чужое — other", () => {
    const hits = parseCspReports([violation("inline"), violation("eval"), violation("chrome-extension://x/y.js"), violation(undefined)]);

    expect(hits.map((hit) => hit.host)).toEqual(["inline", "eval", "other", "other"]);
  });

  it("массив из 25 записей даёт не больше 20 попаданий", () => {
    const hits = parseCspReports(Array.from({ length: 25 }, (_, index) => violation(`https://h${String(index)}.example/x`)));

    expect(hits).toHaveLength(20);
  });

  it("лишние поля записи (url, age, documentURL, referrer) наружу не выходят", () => {
    const hits = parseCspReports([violation("https://a.example/x?uid=7")]);

    expect(hits.every((hit) => Object.keys(hit).sort().join() === "directive,host")).toBe(true);
    expect(JSON.stringify(hits)).not.toMatch(/tgWebAppData|t\.me|uid=7/);
  });
});

describe("мусор вместо тела", () => {
  it.each([
    ["null", null],
    ["число", 7],
    ["строка", "csp-report"],
    ["пустой объект", {}],
    ["массив чисел", [1, 2, 3]],
    ["пустой массив", []],
    ["csp-report не объект", { "csp-report": "x" }],
    ["csp-report — null", { "csp-report": null }],
    ["csp-report — пустой объект", { "csp-report": {} }],
    ["запись report-to без body", [{ type: "csp-violation" }]],
  ])("%s — ноль попаданий и без исключения", (_name, body) => {
    expect(() => parseCspReports(body)).not.toThrow();
    expect(parseCspReports(body)).toEqual([]);
  });
});

class FakeRepository implements CspReportsRepository {
  readonly recorded: { directive: string; host: string; atMs: number }[] = [];
  entries: CspStoredEntry[] = [];
  overflow = 0;
  failWith: Error | null = null;

  async record(hit: { directive: string; host: string }, nowMs: number): Promise<void> {
    if (this.failWith !== null) throw this.failWith;
    this.recorded.push({ ...hit, atMs: nowMs });
  }

  async read(): Promise<{ entries: CspStoredEntry[]; overflow: number }> {
    return { entries: this.entries, overflow: this.overflow };
  }
}

describe("сервис сводки", () => {
  afterEach(() => vi.restoreAllMocks());

  it("каждое попадание тела записывается в хранилище с моментом отчёта", async () => {
    const repository = new FakeRepository();
    const service = new CspReportsService(repository);

    await service.record(
      [
        { type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://a.example/p.gif" } },
        { type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://b.example/p.gif" } },
      ],
      5_000,
    );

    expect(repository.recorded).toEqual([
      { directive: "img-src", host: "a.example", atMs: 5_000 },
      { directive: "img-src", host: "b.example", atMs: 5_000 },
    ]);
  });

  it("мусорное тело ничего не пишет", async () => {
    const repository = new FakeRepository();

    await new CspReportsService(repository).record({ nothing: true }, 1);

    expect(repository.recorded).toEqual([]);
  });

  it("ошибка записи наружу не бросается: отчёт браузера никто не повторяет", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const repository = new FakeRepository();
    repository.failWith = new Error("redis недоступен");
    const service = new CspReportsService(repository);

    await expect(service.record(uriBody("script-src", "https://a.example/x"), 1)).resolves.toBeUndefined();
  });

  it("при сбое хранилища в лог идёт не чаще одной строки в минуту, и в ней нет данных отчёта", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const repository = new FakeRepository();
    repository.failWith = new Error("redis недоступен");
    const service = new CspReportsService(repository);

    await service.record(uriBody("script-src", "https://secret-host.example/x"), 1_000);
    await service.record(uriBody("script-src", "https://secret-host.example/x"), 30_000);
    await service.record(uriBody("script-src", "https://secret-host.example/x"), 61_001);

    expect(warn).toHaveBeenCalledTimes(2);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ module: "csp-reports", event: "record_failed" });
    expect(line).not.toMatch(/secret-host/);
  });

  it("сводка: свежие сверху, момент — ISO-строкой, потолок и переполнение в ответе", async () => {
    const repository = new FakeRepository();
    repository.entries = [
      { directive: "script-src", host: "old.example", count: 9, lastAtMs: Date.parse("2026-10-01T10:00:00.000Z") },
      { directive: "img-src", host: "new.example", count: 2, lastAtMs: Date.parse("2026-10-19T12:30:00.000Z") },
      { directive: "connect-src", host: "mid.example", count: 5, lastAtMs: Date.parse("2026-10-10T08:00:00.000Z") },
    ];
    repository.overflow = 4;

    const summary = await new CspReportsService(repository).summary();

    expect(summary.entries.map((entry) => entry.host)).toEqual(["new.example", "mid.example", "old.example"]);
    expect(summary.entries[0]).toEqual({ directive: "img-src", host: "new.example", count: 2, lastAt: "2026-10-19T12:30:00.000Z" });
    expect(summary.overflow).toBe(4);
    expect(summary.maxEntries).toBe(200);
  });

  it("пустая сводка — пустой список, а не ошибка", async () => {
    const summary = await new CspReportsService(new FakeRepository()).summary();

    expect(summary).toEqual({ entries: [], overflow: 0, maxEntries: 200 });
  });
});
