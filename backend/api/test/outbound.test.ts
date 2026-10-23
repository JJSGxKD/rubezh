import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Outbound, NOOP_SINK, OUTBOUND_SINK, type OutboundRecord, type OutboundSink } from "../src/infra/outbound/outbound.js";
import { OutboundModule } from "../src/infra/outbound/outbound.module.js";
import { OUTBOUND_SERVICES } from "../src/infra/outbound/outbound-services.js";
import { safePath } from "../src/infra/outbound/outbound-path.js";

// Один клиент исходящих запросов (docs/35-stage4-plan.md Р91, Р92, tasks/T-0059):
// fetch с меткой сервиса, запись о каждой попытке в приёмник и ни одного
// секрета из адреса в записи.

const NOW = new Date("2026-10-17T10:00:00.000Z");

afterEach(() => {
  vi.unstubAllGlobals();
});

function capture(): { sink: OutboundSink; records: OutboundRecord[] } {
  const records: OutboundRecord[] = [];
  return { records, sink: { write: (record) => void records.push(record) } };
}

describe("путь без секретов", () => {
  it("токен бота и query отбрасываются", () => {
    expect(safePath("https://api.telegram.org/bot123:ABC/sendMessage?chat_id=1")).toEqual({ host: "api.telegram.org", path: "/bot***/sendMessage" });
  });

  it("ключ в пути скрыт, обычные сегменты остаются", () => {
    expect(safePath("https://v6.exchangerate-api.com/v6/0123456789abcdef01234567/latest/USD")).toEqual({
      host: "v6.exchangerate-api.com",
      path: "/v6/***/latest/USD",
    });
  });

  it("query отбрасывается всегда, даже с токеном", () => {
    expect(safePath("https://api.coingecko.com/api/v3/simple/price?ids=x&x_cg_pro_api_key=SECRETSECRETSECRETSECRET1")).toEqual({
      host: "api.coingecko.com",
      path: "/api/v3/simple/price",
    });
  });

  it("длинный сегмент из знаков ключа скрыт, короткий и с другими знаками — нет", () => {
    expect(safePath("https://x.example/a/abcdefghijklmnopqrstuvwxyz_-0123456789/b").path).toBe("/a/***/b");
    expect(safePath("https://x.example/a/short-segment/b").path).toBe("/a/short-segment/b");
    expect(safePath("https://x.example/a/with.dots.inside.a.very.long.segment.name/b").path).toBe("/a/with.dots.inside.a.very.long.segment.name/b");
  });

  it("порт и учётные данные не попадают в хост; корень — «/»", () => {
    expect(safePath("https://user:pass@x.example:8443/")).toEqual({ host: "x.example", path: "/" });
  });

  it("не адрес — пустые поля, а не исключение", () => {
    expect(safePath("не адрес")).toEqual({ host: "", path: "" });
  });
});

describe("клиент с меткой сервиса", () => {
  function setup(responder: (input: unknown, init?: RequestInit) => Promise<Response> | Response, sink: OutboundSink = NOOP_SINK) {
    const calls: { input: unknown; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return await responder(input, init);
    });
    return { client: new Outbound(sink, () => NOW).forService("fx.cbr"), calls };
  }

  it("200: запись об успехе, ответ отдан как есть", async () => {
    const { sink, records } = capture();
    const { client, calls } = setup(() => new Response("тело", { status: 200 }), sink);

    const response = await client("https://www.cbr-xml-daily.ru/daily_json.js?x=1", { method: "post" });

    expect(await response.text()).toBe("тело");
    expect(calls[0]?.init?.method).toBe("post");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      service: "fx.cbr",
      method: "POST",
      host: "www.cbr-xml-daily.ru",
      path: "/daily_json.js",
      status: 200,
      ok: true,
      via: "direct",
      attempt: 1,
      error: null,
      at: NOW,
    });
    expect(records[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("метод по умолчанию GET; адрес можно передать URL и Request", async () => {
    const { sink, records } = capture();
    const { client } = setup(() => new Response("ok"), sink);
    await client(new URL("https://a.example/one"));
    await client(new Request("https://b.example/two", { method: "PUT" }));
    expect(records.map((record) => [record.method, record.host, record.path])).toEqual([
      ["GET", "a.example", "/one"],
      ["PUT", "b.example", "/two"],
    ]);
  });

  it("500: запись с ok: false и статусом, ответ отдан вызывающему", async () => {
    const { sink, records } = capture();
    const { client } = setup(() => new Response("сбой", { status: 500 }), sink);
    const response = await client("https://x.example/y");
    expect(response.status).toBe(500);
    expect(records[0]).toMatchObject({ ok: false, status: 500, error: null });
  });

  it("таймаут вызывающего: запись timeout, исключение проброшено", async () => {
    const { sink, records } = capture();
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { client } = setup(() => Promise.reject(timeout), sink);
    await expect(client("https://x.example/y", { signal: AbortSignal.timeout(1000) })).rejects.toBe(timeout);
    expect(records[0]).toMatchObject({ ok: false, status: null, error: "timeout" });
  });

  it("отмена не по таймауту — aborted, а AbortError с причиной TimeoutError — timeout", async () => {
    const { sink, records } = capture();
    const aborted = new DOMException("aborted", "AbortError");
    const { client } = setup(() => Promise.reject(aborted), sink);
    await expect(client("https://x.example/y")).rejects.toBe(aborted);

    const viaCause = Object.assign(new DOMException("aborted", "AbortError"), { cause: new DOMException("t", "TimeoutError") });
    vi.stubGlobal("fetch", async () => Promise.reject(viaCause));
    await expect(client("https://x.example/y")).rejects.toBe(viaCause);

    expect(records.map((record) => record.error)).toEqual(["aborted", "timeout"]);
  });

  it("сетевая ошибка: запись network, исключение проброшено", async () => {
    const { sink, records } = capture();
    const failure = new TypeError("fetch failed");
    const { client } = setup(() => Promise.reject(failure), sink);
    await expect(client("https://x.example/y")).rejects.toBe(failure);
    expect(records[0]).toMatchObject({ ok: false, status: null, error: "network" });
  });

  it("приёмник бросает — вызов всё равно отвечает, а ошибка не раскрывается наружу", async () => {
    const broken: OutboundSink = {
      write: () => {
        throw new Error("приёмник сломан");
      },
    };
    const { client } = setup(() => new Response("ok"), broken);
    const response = await client("https://x.example/y");
    expect(await response.text()).toBe("ok");
  });

  it("секрет из адреса в записи не появляется", async () => {
    const { sink, records } = capture();
    const { client } = setup(() => new Response("ok"), sink);
    await client("https://api.telegram.org/bot123456:SECRET-TOKEN/getMe?key=SECRETKEY0123456789ABCDEF");
    expect(JSON.stringify(records)).not.toMatch(/SECRET|123456:/);
  });

  it("каждая попытка — отдельная запись", async () => {
    const { sink, records } = capture();
    const { client } = setup(() => new Response("ok"), sink);
    await client("https://x.example/1");
    await client("https://x.example/2");
    expect(records.map((record) => record.path)).toEqual(["/1", "/2"]);
  });
});

describe("каталог сервисов", () => {
  it("все сервисы из решения T-0059", () => {
    expect([...OUTBOUND_SERVICES].sort()).toEqual(
      ["ads.creatives", "ads.postback", "fx.binance", "fx.cbr", "fx.coingecko", "fx.coinmarketcap", "fx.ecb", "fx.erapi", "fx.tonapi", "secrets.check", "taddy.api", "taddy.exchange", "telegram.bot"].sort(),
    );
  });
});

describe("модуль", () => {
  it("глобальный: Outbound доступен без импорта, приёмник по умолчанию пустой", async () => {
    @Module({})
    class Consumer {}
    @Module({ imports: [OutboundModule, Consumer] })
    class Root {}
    const context = await NestFactory.createApplicationContext(Root, { logger: false });
    try {
      expect(context.get(Outbound)).toBeInstanceOf(Outbound);
      expect(context.get(OUTBOUND_SINK)).toBe(NOOP_SINK);
    } finally {
      await context.close();
    }
  });
});
