import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { ConversionsJournal, cursorOf, parseCursor } from "../src/modules/ad-conversions/conversions-journal.service.js";
import { RETRY_DELAYS_MIN, adsgramPostbackUrl, redacted, retryAt, verdictOf } from "../src/modules/ad-conversions/conversion-rules.js";
import {
  emptySummary,
  type ConversionRow,
  type ConversionSummary,
  type ConversionsRepository,
  type DueConversion,
} from "../src/modules/ad-conversions/conversions.repository.js";
import { AdConversionsService } from "../src/modules/ad-conversions/conversions.service.js";
import { macroQuery, networkParamsOf } from "../src/modules/links/link-networks.js";
import type { RolesService } from "../src/modules/roles/roles.service.js";
import type { SecretDefinition } from "../src/modules/secrets/secret-catalog.js";
import type { SecretsReader } from "../src/modules/secrets/secrets.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Трекинг закупок рекламы (docs/35-stage4-plan.md Р86, WP43): макросы сети
 * на клике, адрес постбэка по документации AdsGram, отправка с повторами и
 * без потерь — нет токена, сеть лежит, сеть отказала.
 */

const NOW = new Date("2026-10-02T12:00:00.000Z");
const TOKEN = "tok_abc12345";

class MemoryConversions implements ConversionsRepository {
  queue: DueConversion[] = [];
  readonly calls: string[] = [];
  readonly states = new Map<string, { status: string; attempts: number; nextAt: Date | null; httpStatus: number | null; error: string | null; reason: string | null }>();
  sweeps = 0;

  async sweep(): Promise<{ registrations: number; purchases: number }> {
    this.sweeps += 1;
    return { registrations: 1, purchases: 0 };
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
  async requeue(linkCode: string, conversionId: string): Promise<ConversionRow | null> {
    this.calls.push(`requeue:${linkCode}:${conversionId}`);
    return conversionId === "missing" ? null : { conversionId, goal: 1, status: "pending", reason: null, attempts: 0, httpStatus: null, lastError: null, accountId: "a", createdAt: NOW, sentAt: null, nextAttemptAt: NOW };
  }
}

class FakeLock {
  held = false;
  async set(): Promise<"OK" | null> {
    return this.held ? null : "OK";
  }
  async eval(): Promise<number> {
    return 1;
  }
}

function secretsWith(token: string | null): SecretsReader {
  return { get: (secret: SecretDefinition) => (secret.key === "adsgram.conversion-token" ? token : null) };
}

function due(patch: Partial<DueConversion> = {}): DueConversion {
  return { conversionId: "c1", network: "adsgram", goal: 1, attempts: 0, params: { record: "7f3a1b6c", campaign: "55" }, telegramId: "790807933", ...patch };
}

function setup(token: string | null = TOKEN) {
  const repository = new MemoryConversions();
  const lock = new FakeLock();
  const service = new AdConversionsService(loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv), repository, secretsWith(token), lock as never);
  return { repository, lock, service };
}

function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetchImpl = (async (input: URL | string) => {
    urls.push(String(input));
    return await respond(String(input));
  }) as typeof fetch;
  return { urls, fetchImpl };
}

describe("ссылка с макросами", () => {
  it("адрес для кабинета AdsGram — все пять макросов, как в документации сети", () => {
    expect(macroQuery("adsgram")).toBe("campaign={campaign_id}&banner={banner_id}&pub={publisher_id}&clickid={click_id}&record={record_data}");
  });

  it("на клике — только подставленные сетью значения", () => {
    expect(networkParamsOf("adsgram", { campaign: " 55 ", record: "7f3a", pub: "{publisher_id}", banner: "has space", junk: "1" })).toEqual({ campaign: "55", record: "7f3a" });
    expect(networkParamsOf("adsgram", { record: "{record_data}" })).toBeNull();
    expect(networkParamsOf("adsgram", { record: "x".repeat(257) })).toBeNull();
  });
});

describe("постбэк AdsGram", () => {
  it("веб-ссылка — record; без него — вариант ссылок Telegram: tgid и campaignid; без обоих — не отправить", () => {
    expect(adsgramPostbackUrl(TOKEN, { goal: 2, params: { record: "7f3a1b6c", campaign: "55" }, telegramId: "1" })?.toString()).toBe(
      `https://api.adsgram.ai/confirm_conversion?token=${TOKEN}&record=7f3a1b6c&goaltype=2`,
    );
    expect(adsgramPostbackUrl(TOKEN, { goal: 1, params: { campaign: "55" }, telegramId: "790807933" })?.toString()).toBe(
      `https://api.adsgram.ai/confirm_conversion?token=${TOKEN}&tgid=790807933&campaignid=55&goaltype=1`,
    );
    expect(adsgramPostbackUrl(TOKEN, { goal: 1, params: { campaign: "55" }, telegramId: null })).toBeNull();
    expect(adsgramPostbackUrl(TOKEN, { goal: 1, params: { campaign: "55" }, telegramId: "dev-1" })).toBeNull();
    expect(adsgramPostbackUrl(TOKEN, { goal: 1, params: null, telegramId: "1" })).toBeNull();
  });

  it("в лог — без токена", () => {
    const url = adsgramPostbackUrl(TOKEN, { goal: 3, params: { record: "r1" }, telegramId: null });
    expect(url === null ? "" : redacted(url)).not.toContain(TOKEN);
  });

  it("ответ сети: 2xx — отправлено, отказ по сути — не повторять, сбой — повторить", () => {
    expect(verdictOf(200)).toBe("sent");
    expect(verdictOf(400)).toBe("rejected");
    expect(verdictOf(401)).toBe("rejected");
    expect(verdictOf(429)).toBe("retry");
    expect(verdictOf(503)).toBe("retry");
  });

  it("паузы растут, после последней — больше не пробовать", () => {
    expect(retryAt(1, NOW)?.toISOString()).toBe("2026-10-02T12:01:00.000Z");
    expect(retryAt(RETRY_DELAYS_MIN.length, NOW)?.toISOString()).toBe("2026-10-03T12:00:00.000Z");
    expect(retryAt(RETRY_DELAYS_MIN.length + 1, NOW)).toBeNull();
  });
});

describe("отправка", () => {
  it("проход: конверсии находятся, созревшие уходят токеном нашего кабинета", async () => {
    const { repository, service } = setup();
    repository.queue = [due()];
    const { urls, fetchImpl } = fakeFetch(() => new Response("ok", { status: 200 }));
    const report = await service.tick(NOW, fetchImpl);
    expect(report).toMatchObject({ registrations: 1, sent: 1 });
    expect(urls).toEqual([`https://api.adsgram.ai/confirm_conversion?token=${TOKEN}&record=7f3a1b6c&goaltype=1`]);
    expect(repository.states.get("c1")).toMatchObject({ status: "sent", httpStatus: 200 });
  });

  it("токена нет — конверсия ждёт и не тратит попыток, сеть не спрашивается", async () => {
    const { repository, service } = setup(null);
    repository.queue = [due()];
    const { urls, fetchImpl } = fakeFetch(() => new Response("", { status: 200 }));
    await service.tick(NOW, fetchImpl);
    expect(urls).toEqual([]);
    expect(repository.states.get("c1")).toMatchObject({ status: "pending", attempts: 0, reason: "no_token", nextAt: new Date("2026-10-02T12:05:00.000Z") });
  });

  it("сеть лежит — повтор по расписанию; отказала по сути — «не отправлена» с её ответом", async () => {
    const { repository, service } = setup();
    repository.queue = [due({ conversionId: "down", attempts: 2 }), due({ conversionId: "bad" })];
    const { fetchImpl } = fakeFetch((url) => (url.includes("record") && repository.states.size === 0 ? new Response("busy", { status: 503 }) : new Response("invalid record", { status: 400 })));
    await service.tick(NOW, fetchImpl);
    expect(repository.states.get("down")).toMatchObject({ status: "pending", attempts: 3, httpStatus: 503, nextAt: new Date("2026-10-02T12:15:00.000Z") });
    expect(repository.states.get("bad")).toMatchObject({ status: "failed", attempts: 1, httpStatus: 400, error: "ответ 400: invalid record" });
  });

  it("не ответила за 5 секунд — повтор; кончились попытки — «не отправлена»", async () => {
    const { repository, service } = setup();
    repository.queue = [due({ conversionId: "slow" }), due({ conversionId: "last", attempts: RETRY_DELAYS_MIN.length })];
    const { fetchImpl } = fakeFetch(() => Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
    await service.tick(NOW, fetchImpl);
    expect(repository.states.get("slow")).toMatchObject({ status: "pending", attempts: 1, error: "сеть не ответила за 5 секунд" });
    expect(repository.states.get("last")).toMatchObject({ status: "failed" });
  });

  it("сеть не подставила макросы — не отправлять: она не узнает, чья это конверсия", async () => {
    const { repository, service } = setup();
    repository.queue = [due({ params: null })];
    const { urls, fetchImpl } = fakeFetch(() => new Response("", { status: 200 }));
    await service.tick(NOW, fetchImpl);
    expect(urls).toEqual([]);
    expect(repository.states.get("c1")).toMatchObject({ status: "skipped", reason: "no_macros" });
  });

  it("проход идёт на одной реплике: лок у другой — ничего не делается", async () => {
    const { repository, lock, service } = setup();
    lock.held = true;
    expect(await service.tick(NOW, fakeFetch(() => new Response("")).fetchImpl)).toBeNull();
    expect(repository.sweeps).toBe(0);
  });
});

describe("журнал в панели", () => {
  it("повтор — с правом и в аудит; уже ушедшую повторить нельзя", async () => {
    const audits: unknown[] = [];
    const roles = { require: async () => undefined, audit: async (entry: unknown) => void audits.push(entry) } as unknown as RolesService;
    const repository = new MemoryConversions();
    const journal = new ConversionsJournal(repository, roles);
    expect(await journal.requeue({ accountId: "a1", platform: "telegram", platformUserId: "1" }, "Code123456", "c1")).toMatchObject({ status: "pending" });
    expect(audits).toEqual([{ actorAccountId: "a1", action: "links.conversion.send", target: "Code123456", after: { conversionId: "c1", goal: 1 } }]);
    expect(await journal.requeue({ accountId: "a1", platform: "telegram", platformUserId: "1" }, "Code123456", "missing")).toBeNull();
    expect(audits).toHaveLength(1);
    expect(emptySummary()[2]).toEqual({ pending: 0, sent: 0, failed: 0, skipped: 0 });
  });

  it("курсор страницы — время и идентификатор туда и обратно; чужая строка — не курсор", () => {
    const row = { createdAt: NOW, conversionId: "0b6f2c1e-5d4a-4e8b-9c7d-1a2b3c4d5e6f" };
    expect(parseCursor(cursorOf(row))).toEqual(row);
    expect(parseCursor(NOW.toISOString())).toBeNull();
    expect(parseCursor(`${NOW.toISOString()}_' OR 1=1 --`)).toBeNull();
    expect(parseCursor("2026-13-45T99:99:99.000Z_0b6f2c1e-5d4a-4e8b-9c7d-1a2b3c4d5e6f")).toBeNull();
  });
});
