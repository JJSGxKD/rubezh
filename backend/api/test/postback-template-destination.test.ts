import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { ConversionRow, ConversionSummary, ConversionsRepository, DueConversion } from "../src/modules/ad-conversions/conversions.repository.js";
import { AdConversionsService } from "../src/modules/ad-conversions/conversions.service.js";
import { TemplateDestination } from "../src/modules/ad-conversions/destinations/template.destination.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Назначения «адрес сети» (`s2s`) и «партнёр» на общем шаблоне (tasks/T-0070): что уходит запросом,
 * когда строка пропускается и когда адрес не проходит проверку при отправке. Правила шаблона —
 * postback-template.test.ts, внутренние адреса — postback-address.test.ts.
 */

const NOW = new Date("2026-11-08T12:00:00.000Z");
const CONVERSION_ID = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const PUBLIC_IP = async () => ["93.184.216.34"];

const ADDRESS = "https://track.example.com/pb?cid={click_id}&e={event}&id={event_id}&a={amount}&c={currency}&s1={sub1}";

function due(patch: Partial<DueConversion> = {}): DueConversion {
  return {
    conversionId: CONVERSION_ID,
    destination: "s2s",
    event: "registration",
    attempts: 0,
    params: { click_id: "k1", sub1: "x-y" },
    telegramId: "790807933",
    purchase: null,
    postbackUrl: ADDRESS,
    ...patch,
  };
}

function destination(kind: "s2s" | "partner" = "s2s", lookup: (host: string) => Promise<readonly string[]> = PUBLIC_IP): TemplateDestination {
  return new TemplateDestination(kind, lookup);
}

describe("TemplateDestination.prepare", () => {
  it("принимает все четыре события; вид — s2s или partner", () => {
    expect(destination("s2s").kind).toBe("s2s");
    expect(destination("partner").kind).toBe("partner");
    expect([...destination().accepts]).toEqual(["registration", "purchase_first", "purchase_repeat", "d1_return"]);
  });

  it("регистрация: адрес собран ровно, запрос GET без перенаправлений, в лог — без запроса", async () => {
    const prepared = await destination().prepare(due());
    if (prepared.kind !== "request") throw new Error(`ждали запрос, получили ${prepared.kind}`);
    expect(prepared.url.toString()).toBe(`https://track.example.com/pb?cid=k1&e=registration&id=${CONVERSION_ID}&a=0&c=&s1=x-y`);
    expect(prepared.init).toMatchObject({ method: "GET", redirect: "manual", headers: { "user-agent": "rubezh-postback/1" } });
    expect(prepared.logUrl).toBe("https://track.example.com/pb?***");
  });

  it("покупка: сумма и валюта как заплачено, событие — purchase_first", async () => {
    const prepared = await destination("partner").prepare(due({ destination: "partner", event: "purchase_first", purchase: { amount: 50, currency: "XTR" } }));
    expect(prepared.kind === "request" ? prepared.url.toString() : prepared.kind).toBe(`https://track.example.com/pb?cid=k1&e=purchase_first&id=${CONVERSION_ID}&a=50&c=XTR&s1=x-y`);
  });

  it("все sub1…sub5 из параметров клика; нет — пусто", async () => {
    const prepared = await destination().prepare(due({ postbackUrl: "https://t.example.com/p?a={sub1}&b={sub2}&c={sub3}&d={sub4}&e={sub5}", params: { sub2: "два", sub5: "пять" } }));
    expect(prepared.kind === "request" ? prepared.url.search : prepared.kind).toBe(`?a=&b=${encodeURIComponent("два")}&c=&d=&e=${encodeURIComponent("пять")}`);
  });

  it("значения с &, = и # кодируются: чужой параметр в запрос не попадает", async () => {
    const prepared = await destination().prepare(due({ params: { click_id: "a&b=c#d", sub1: "{click_id}" } }));
    if (prepared.kind !== "request") throw new Error(prepared.kind);
    expect(prepared.url.search).toContain("cid=a%26b%3Dc%23d");
    expect(prepared.url.searchParams.get("s1")).toBe("{click_id}");
    expect([...prepared.url.searchParams.keys()]).toEqual(["cid", "e", "id", "a", "c", "s1"]);
  });

  it("адреса нет — пропуск no_address", async () => {
    expect(await destination().prepare(due({ postbackUrl: null }))).toEqual({ kind: "skip", reason: "no_address" });
  });

  it("в шаблоне {click_id}, а в клике его не было — пропуск no_click_id", async () => {
    expect(await destination().prepare(due({ params: null }))).toEqual({ kind: "skip", reason: "no_click_id" });
    expect(await destination().prepare(due({ params: { sub1: "x" } }))).toEqual({ kind: "skip", reason: "no_click_id" });
  });

  it("шаблон без {click_id} уходит и без параметров клика", async () => {
    const prepared = await destination().prepare(due({ postbackUrl: "https://track.example.com/pb?e={event}&id={event_id}", params: null }));
    expect(prepared.kind === "request" ? prepared.url.toString() : prepared.kind).toBe(`https://track.example.com/pb?e=registration&id=${CONVERSION_ID}`);
  });

  it("ужесточились правила, а адрес сохранён раньше: отказ без повтора", async () => {
    for (const postbackUrl of ["https://localhost/pb?cid={click_id}", "http://track.example.com/pb", "https://meta.internal/pb", "https://u:p@track.example.com/pb"]) {
      const prepared = await destination().prepare(due({ postbackUrl }));
      expect(prepared, postbackUrl).toMatchObject({ kind: "fail", retry: false });
    }
  });

  it("подстановка длиннее 2048 знаков: отказ без повтора с понятным текстом", async () => {
    const long = "é".repeat(256);
    const prepared = await destination().prepare(
      due({
        postbackUrl: "https://track.example.com/pb?a={sub1}&b={sub2}&c={sub3}&d={sub4}&e={sub5}&f={click_id}",
        params: { click_id: long, sub1: long, sub2: long, sub3: long, sub4: long, sub5: long },
      }),
    );
    expect(prepared).toEqual({ kind: "fail", message: "Адрес после подстановки длиннее 2048 знаков", retry: false });
  });

  it("имя сайта не разрешилось — отказ с повтором; разрешилось во внутренний IP — без повтора", async () => {
    const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND track.example.com"), { code: "ENOTFOUND" });
    const unresolved = await destination("s2s", async () => Promise.reject(notFound)).prepare(due());
    expect(unresolved).toMatchObject({ kind: "fail", retry: true });
    expect(unresolved.kind === "fail" ? unresolved.message : "").toMatch(/^Адрес не прошёл проверку: /);

    const rebound = await destination("s2s", async () => ["127.0.0.1"]).prepare(due());
    expect(rebound).toMatchObject({ kind: "fail", retry: false });
    expect(rebound.kind === "fail" ? rebound.message : "").toMatch(/^Адрес не прошёл проверку: /);
  });

  it("текст отказа не содержит запроса адреса", async () => {
    const prepared = await destination("s2s", async () => ["10.0.0.1"]).prepare(due({ postbackUrl: "https://track.example.com/pb?token=SECRET_VALUE&cid={click_id}" }));
    expect(JSON.stringify(prepared)).not.toContain("SECRET_VALUE");
  });
});

// --- Через сервис отправки: ответы приёмника, повторы, журнал и лог ---

class Queue implements ConversionsRepository {
  queue: DueConversion[] = [];
  readonly states = new Map<string, { status: string; attempts: number; nextAt: Date | null; httpStatus: number | null; error: string | null; reason: string | null }>();
  async sweep(): Promise<{ registrations: number; purchases: number }> {
    return { registrations: 0, purchases: 0 };
  }
  async due(): Promise<DueConversion[]> {
    return this.queue;
  }
  async markSent(conversionId: string, httpStatus: number): Promise<void> {
    this.states.set(conversionId, { status: "sent", attempts: 1, nextAt: null, httpStatus, error: null, reason: null });
  }
  async markFailed(conversionId: string, attempts: number, nextAt: Date | null, httpStatus: number | null, error: string): Promise<void> {
    this.states.set(conversionId, { status: nextAt === null ? "failed" : "pending", attempts, nextAt, httpStatus, error, reason: null });
  }
  async defer(conversionId: string, nextAt: Date, reason: string): Promise<void> {
    this.states.set(conversionId, { status: "pending", attempts: 0, nextAt, httpStatus: null, error: null, reason });
  }
  async skip(conversionId: string, reason: string): Promise<void> {
    this.states.set(conversionId, { status: "skipped", attempts: 0, nextAt: null, httpStatus: null, error: null, reason });
  }
  async purgeParams(): Promise<number> {
    return 0;
  }
  async summaries(): Promise<Map<string, ConversionSummary>> {
    return new Map();
  }
  async journal(): Promise<ConversionRow[]> {
    return [];
  }
  async requeue(): Promise<ConversionRow | null> {
    return null;
  }
}

class FreeLock {
  async set(): Promise<"OK"> {
    return "OK";
  }
  async eval(): Promise<number> {
    return 1;
  }
}

function serviceOver(repository: Queue, ...kinds: ("s2s" | "partner")[]) {
  return new AdConversionsService(
    loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv),
    repository,
    kinds.map((kind) => destination(kind)),
    new FreeLock() as never,
  );
}

function captureLog(): string[] {
  const lines: string[] = [];
  const sink = (message: unknown): void => void lines.push(String(message));
  vi.spyOn(Logger.prototype, "log").mockImplementation(sink);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(sink);
  return lines;
}

function fakeFetch(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return await respond(String(input), init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("отправка назначением «адрес сети» через сервис", () => {
  it("200 — отправлено, запрос один и без перенаправлений", async () => {
    const repository = new Queue();
    repository.queue = [due()];
    const { calls, fetchImpl } = fakeFetch(() => new Response("ok", { status: 200 }));
    const report = await serviceOver(repository, "s2s").tick(NOW, fetchImpl);
    expect(report).toMatchObject({ sent: 1, failed: 0, deferred: 0, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://track.example.com/pb?cid=k1&e=registration&id=${CONVERSION_ID}&a=0&c=&s1=x-y`);
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(repository.states.get(CONVERSION_ID)).toMatchObject({ status: "sent", httpStatus: 200 });
  });

  it("302 — не отправлено, переход не выполняется: второго запроса нет", async () => {
    const repository = new Queue();
    repository.queue = [due()];
    const { calls, fetchImpl } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.org/" } }));
    const report = await serviceOver(repository, "s2s").tick(NOW, fetchImpl);
    expect(report).toMatchObject({ sent: 0, failed: 1 });
    expect(calls).toHaveLength(1);
    expect(repository.states.get(CONVERSION_ID)).toMatchObject({ status: "failed", httpStatus: 302 });
  });

  it("500 — повтор по расписанию; повтор той же строки несёт тот же event_id", async () => {
    const repository = new Queue();
    repository.queue = [due()];
    const { calls, fetchImpl } = fakeFetch(() => new Response("oops", { status: 500 }));
    const service = serviceOver(repository, "s2s");
    expect(await service.tick(NOW, fetchImpl)).toMatchObject({ deferred: 1, failed: 0 });
    expect(repository.states.get(CONVERSION_ID)).toMatchObject({ status: "pending", attempts: 1 });

    repository.queue = [due({ attempts: 1 })];
    await service.tick(new Date(NOW.getTime() + 60_000), fetchImpl);
    expect(calls).toHaveLength(2);
    const ids = calls.map((call) => new URL(call.url).searchParams.get("id"));
    expect(ids).toEqual([CONVERSION_ID, CONVERSION_ID]);
  });

  it("партнёр и адрес сети идут каждый своим назначением; конверсия чужого вида не берётся", async () => {
    const repository = new Queue();
    repository.queue = [due({ conversionId: "s", destination: "s2s" }), due({ conversionId: "p", destination: "partner" })];
    const { calls, fetchImpl } = fakeFetch(() => new Response("ok", { status: 200 }));
    expect(await serviceOver(repository, "s2s", "partner").tick(NOW, fetchImpl)).toMatchObject({ sent: 2 });
    expect(calls).toHaveLength(2);

    const only = new Queue();
    only.queue = [due({ conversionId: "p", destination: "partner" })];
    const other = fakeFetch(() => new Response("ok", { status: 200 }));
    expect(await serviceOver(only, "s2s").tick(NOW, other.fetchImpl)).toMatchObject({ skipped: 1, sent: 0 });
    expect(other.calls).toHaveLength(0);
  });

  it("адрес снят после создания строки — пропуск no_address, запроса нет", async () => {
    const repository = new Queue();
    repository.queue = [due({ postbackUrl: null })];
    const { calls, fetchImpl } = fakeFetch(() => new Response("ok", { status: 200 }));
    expect(await serviceOver(repository, "s2s").tick(NOW, fetchImpl)).toMatchObject({ skipped: 1 });
    expect(calls).toHaveLength(0);
    expect(repository.states.get(CONVERSION_ID)).toMatchObject({ status: "skipped", reason: "no_address" });
  });

  it("запрос адреса не попадает ни в лог, ни в журнал: ни в успех, ни в отказ, ни в сбой сети", async () => {
    const secret = "https://track.example.com/pb?token=SECRET_VALUE&cid={click_id}";
    const outcomes: [string, () => Response | Promise<Response>][] = [
      ["500", () => new Response("echo /pb?token=SECRET_VALUE&cid=k1", { status: 500 })],
      ["400", () => new Response("echo /pb?token=SECRET_VALUE&cid=k1", { status: 400 })],
      ["302", () => new Response(null, { status: 302, headers: { location: "https://track.example.com/pb?token=SECRET_VALUE" } })],
      ["сбой", () => Promise.reject(new Error("connect ECONNREFUSED https://track.example.com/pb?token=SECRET_VALUE&cid=k1"))],
    ];
    for (const [label, respond] of outcomes) {
      const lines = captureLog();
      const repository = new Queue();
      repository.queue = [due({ postbackUrl: secret })];
      const { fetchImpl } = fakeFetch(respond);
      await serviceOver(repository, "s2s").tick(NOW, fetchImpl);
      const state = repository.states.get(CONVERSION_ID);
      expect(state, label).toBeDefined();
      const everything = JSON.stringify(state) + lines.join("\n");
      expect(everything, label).not.toContain("SECRET_VALUE");
      expect(everything, label).not.toContain("cid=k1");
      vi.restoreAllMocks();
    }
  });

  it("в лог идёт адрес без запроса", async () => {
    const lines = captureLog();
    const repository = new Queue();
    repository.queue = [due()];
    const { fetchImpl } = fakeFetch(() => new Response("oops", { status: 500 }));
    await serviceOver(repository, "s2s").tick(NOW, fetchImpl);
    const rejected = lines.find((line) => line.includes("postback_rejected"));
    expect(rejected).toContain("https://track.example.com/pb?***");
  });
});
