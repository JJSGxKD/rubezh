import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { Outbound } from "../src/infra/outbound/outbound.js";
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
import { AdsgramDestination } from "../src/modules/ad-conversions/destinations/adsgram.destination.js";
import type { DestinationKind, PostbackDestination, Prepared } from "../src/modules/ad-conversions/destinations/destination.js";
import type { PostbackEvent } from "../src/modules/ad-conversions/postback-events.js";
import { parseStartParam } from "../src/modules/attribution/start-param.js";
import { directConversionRows, type DirectCandidate } from "../src/modules/ad-conversions/direct-launch-sweep.js";
import { directMacroTail, LINK_NETWORK_PROFILES, macroQuery, networkParamsOf, networkTailParams } from "../src/modules/links/link-networks.js";
import { directUrl } from "../src/modules/links/link-targets.js";
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
    return conversionId === "missing" ? null : { conversionId, goal: 1, event: "registration", destination: "adsgram", status: "pending", reason: null, attempts: 0, httpStatus: null, lastError: null, accountId: "a", createdAt: NOW, sentAt: null, nextAttemptAt: NOW };
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
  return {
    conversionId: "c1",
    destination: "adsgram",
    event: "registration",
    attempts: 0,
    params: { record: "7f3a1b6c", campaign: "55" },
    telegramId: "790807933",
    purchase: null,
    ...patch,
  };
}

function setup(token: string | null = TOKEN, destinations?: PostbackDestination[], outbound?: Outbound) {
  const repository = new MemoryConversions();
  const lock = new FakeLock();
  const service = new AdConversionsService(
    loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv),
    repository,
    destinations ?? [new AdsgramDestination(secretsWith(token))],
    lock as never,
    outbound,
  );
  return { repository, lock, service };
}

/** Подменное назначение: что подготовить — решает тест, вызовы запоминаются. */
class FakeDestination implements PostbackDestination {
  readonly prepared: string[] = [];
  constructor(
    readonly kind: DestinationKind,
    readonly accepts: readonly PostbackEvent[],
    private readonly answer: Prepared | (() => Promise<Prepared>),
  ) {}
  async prepare(conversion: DueConversion): Promise<Prepared> {
    this.prepared.push(conversion.conversionId);
    return typeof this.answer === "function" ? await this.answer() : this.answer;
  }
}

const ALL_EVENTS: readonly PostbackEvent[] = ["registration", "purchase_first", "purchase_repeat", "d1_return"];
const SECRET_URL = "https://hook.example.test/in?token=SECRET_VALUE&e=reg";
const SAFE_URL = "https://hook.example.test/in?token=***&e=reg";

/** Строки, ушедшие в лог сервиса за тест. */
function captureLog() {
  const lines: string[] = [];
  const sink = (message: unknown): void => void lines.push(String(message));
  vi.spyOn(Logger.prototype, "log").mockImplementation(sink);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(sink);
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

// Прямая ссылка на Mini App (Р117, Р121, T-0181): метки сети едут в стартовом параметре, а конверсия
// выводится из первого касания `link`, а не из клика.
describe("метки сети в прямой ссылке (T-0181)", () => {
  const CODE = "AbC123xyz9";
  const TAIL = "_campaign-{campaign_id}_clickid-{click_id}_record-{record_data}";
  const SAMPLE = `l-${CODE}_campaign-55_clickid-3f2a-9c_record-rec123`;

  it("directMacroTail: ключи прямой ссылки AdsGram, значения — макросы профиля, без кодирования", () => {
    expect(directMacroTail("adsgram")).toBe(TAIL);
  });

  it("профиль: прямые ключи входят в макросы, record последний, в хвосте только знаки Telegram и скобки", () => {
    const profile = LINK_NETWORK_PROFILES.adsgram;
    expect(profile.direct).toEqual(["campaign", "clickid", "record"]);
    for (const key of profile.direct) expect(Object.keys(profile.macros), key).toContain(key);
    expect(profile.direct.at(-1)).toBe("record");
    expect(directMacroTail("adsgram")).toMatch(/^[A-Za-z0-9_\-{}]+$/);
    // banner и pub в прямую ссылку не входят.
    expect(directMacroTail("adsgram")).not.toMatch(/banner|pub/);
  });

  it("networkTailParams: хвост после кода разбирается по ключам сети; чужой хвост — null", () => {
    expect(networkTailParams("_campaign-55_clickid-3f2a-9c_record-r_5-aB_9")).toEqual({ campaign: "55", clickid: "3f2a-9c", record: "r_5-aB_9" });
    expect(networkTailParams("_banner-9_pub-3")).toEqual({ banner: "9", pub: "3" });
    expect(networkTailParams("_campaign-_clickid-77_record-")).toEqual({ clickid: "77" });
    expect(networkTailParams("_campaign-1_campaign-2")).toEqual({ campaign: "1" });
    for (const tail of ["", "_", "_hello", "_foo-1", "campaign-5", "_hello_campaign-5", "_campaign-", "_campaign-_record-", "_Campaign-5"]) {
      expect(networkTailParams(tail), tail).toBeNull();
    }
  });

  it("круг: адрес из панели, подставленные сетью значения и разбор запуска дают те же метки", () => {
    const builders = {
      launch: (param: string, rawTail?: string) => `https://t.me/rubezh_bot?startapp=${encodeURIComponent(param)}${rawTail ?? ""}`,
      chat: () => null,
      landingBase: "",
    };
    const url = directUrl({ code: CODE, target: "app", network: "adsgram" }, builders);
    expect(url).not.toBeNull();
    // Сеть подставляет значения вместо макросов в адрес, и Telegram отдаёт игре часть после `startapp=`.
    const substituted = (url ?? "").replace("{campaign_id}", "55").replace("{click_id}", "3f2a-9c").replace("{record_data}", "r_5-aB_9");
    const startParam = substituted.split("startapp=")[1] ?? "";
    expect(parseStartParam(startParam)).toEqual({ kind: "link", raw: startParam, ref: CODE, networkParams: { campaign: "55", clickid: "3f2a-9c", record: "r_5-aB_9" } });
    // Тот же запуск без подстановки (макросы остались буквальными) в игру не попадёт: скобок нет в алфавите Telegram.
    expect(parseStartParam((url ?? "").split("startapp=")[1])).toEqual({ kind: "unknown", raw: null, ref: null });
  });

  describe("directConversionRows", () => {
    const candidate = (patch: Partial<DirectCandidate> = {}): DirectCandidate => ({
      accountId: "acc-1",
      linkCode: CODE,
      network: "adsgram",
      destination: "adsgram",
      goal: 1,
      purchaseId: null,
      startParam: SAMPLE,
      team: false,
      ...patch,
    });

    it("полный образец: метки из трёх ключей, клика нет, строка ждёт отправки с временем прохода", () => {
      const [row] = directConversionRows([candidate()], NOW);
      expect(row).toMatchObject({
        accountId: "acc-1",
        linkCode: CODE,
        destination: "adsgram",
        network: "adsgram",
        goal: 1,
        purchaseId: null,
        clickId: null,
        status: "pending",
        reason: null,
        networkParams: { campaign: "55", clickid: "3f2a-9c", record: "rec123" },
        createdAt: NOW,
        nextAttemptAt: NOW,
      });
    });

    it("покупка несёт оплату и цель; метки те же", () => {
      const rows = directConversionRows([candidate({ goal: 2, purchaseId: "p-1" }), candidate({ goal: 3, purchaseId: "p-2" })], NOW);
      expect(rows.map((row) => [row.goal, row.purchaseId, row.networkParams])).toEqual([
        [2, "p-1", { campaign: "55", clickid: "3f2a-9c", record: "rec123" }],
        [3, "p-2", { campaign: "55", clickid: "3f2a-9c", record: "rec123" }],
      ]);
    });

    it("аккаунт команды пропущен с причиной team, но строка пишется: повтор из панели возможен", () => {
      const [row] = directConversionRows([candidate({ team: true })], NOW);
      expect(row).toMatchObject({ status: "skipped", reason: "team", networkParams: { record: "rec123" } });
    });

    it("параметр другого вида, пустой или с чужим кодом — меток нет, строка всё равно пишется", () => {
      const cases = ["c-AbCdEf123456", "invite", "src-tgads_cmp-oct", `l-ZzZ999zzz9_record-rec123`, null, "мусор"];
      const rows = directConversionRows(cases.map((startParam) => candidate({ startParam })), NOW);
      expect(rows).toHaveLength(cases.length);
      for (const row of rows) expect(row, String(row.networkParams)).toMatchObject({ networkParams: null, status: "pending", clickId: null });
    });

    it("запуск без разобранных меток (`l-<код>` или нераспознанный хвост) — метки пусты", () => {
      const rows = directConversionRows([candidate({ startParam: `l-${CODE}` }), candidate({ startParam: `l-${CODE}_hello` })], NOW);
      expect(rows.map((row) => row.networkParams)).toEqual([null, null]);
    });

    it("ссылка без сети или сеть, о которой сервер не знает, — метки отбрасываются по профилю ссылки", () => {
      const rows = directConversionRows([candidate({ network: null }), candidate({ network: "future-net" })], NOW);
      expect(rows.map((row) => row.networkParams)).toEqual([null, null]);
    });

    it("метки фильтруются как у клика: только ключи профиля, только печатные значения до 256 знаков", () => {
      const [row] = directConversionRows([candidate({ startParam: `l-${CODE}_campaign-5_banner-9_pub-3_clickid-c1_record-r1` })], NOW);
      expect(row?.networkParams).toEqual({ campaign: "5", banner: "9", pub: "3", clickid: "c1", record: "r1" });
    });

    it("назначение берётся из кандидата: тот же запуск у двух назначений — две строки, каждая со своим именем", () => {
      const rows = directConversionRows([candidate(), candidate({ destination: "s2s" })], NOW);
      expect(rows.map((row) => [row.destination, row.network])).toEqual([
        ["adsgram", "adsgram"],
        ["s2s", "s2s"],
      ]);
    });

    it("пустой список — пусто", () => {
      expect(directConversionRows([], NOW)).toEqual([]);
    });
  });

  it("постбэк из прямых меток: record + goaltype; только campaign и Telegram ID — tgid + campaignid; без меток — нет", () => {
    expect(adsgramPostbackUrl(TOKEN, { goal: 1, params: { campaign: "55", clickid: "3f2a-9c", record: "rec123" }, telegramId: "790807933" })?.toString()).toBe(
      `https://api.adsgram.ai/confirm_conversion?token=${TOKEN}&record=rec123&goaltype=1`,
    );
    expect(adsgramPostbackUrl(TOKEN, { goal: 3, params: { campaign: "55" }, telegramId: "790807933" })?.toString()).toBe(
      `https://api.adsgram.ai/confirm_conversion?token=${TOKEN}&tgid=790807933&campaignid=55&goaltype=3`,
    );
    // Только clickid — для постбэка метка бесполезна: сеть не узнает конверсию.
    expect(adsgramPostbackUrl(TOKEN, { goal: 1, params: { clickid: "3f2a-9c" }, telegramId: "790807933" })).toBeNull();
    expect(adsgramPostbackUrl(TOKEN, { goal: 1, params: null, telegramId: "790807933" })).toBeNull();
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

describe("назначения постбэков", () => {
  it("назначение отказало без повтора — «не отправлена» с его текстом, попытка засчитана, сеть не спрашивается", async () => {
    const destination = new FakeDestination("s2s", ALL_EVENTS, { kind: "fail", message: "в шаблоне адреса нет макроса {click_id}", retry: false });
    const { repository, service } = setup(TOKEN, [destination]);
    repository.queue = [due({ destination: "s2s" })];
    const { urls, fetchImpl } = fakeFetch(() => new Response("", { status: 200 }));
    const report = await service.tick(NOW, fetchImpl);
    expect(urls).toEqual([]);
    expect(report).toMatchObject({ failed: 1, deferred: 0, sent: 0 });
    expect(repository.states.get("c1")).toMatchObject({ status: "failed", attempts: 1, nextAt: null, httpStatus: null, error: "в шаблоне адреса нет макроса {click_id}" });
  });

  it("назначение отказало с повтором — повтор по расписанию; попытки кончились — «не отправлена»", async () => {
    const destination = new FakeDestination("s2s", ALL_EVENTS, { kind: "fail", message: "приёмник недоступен", retry: true });
    const { repository, service } = setup(TOKEN, [destination]);
    repository.queue = [due({ conversionId: "again", destination: "s2s", attempts: 2 }), due({ conversionId: "last", destination: "s2s", attempts: RETRY_DELAYS_MIN.length })];
    const report = await service.tick(NOW, fakeFetch(() => new Response("")).fetchImpl);
    expect(report).toMatchObject({ failed: 1, deferred: 1 });
    expect(repository.states.get("again")).toMatchObject({ status: "pending", attempts: 3, nextAt: new Date("2026-10-02T12:15:00.000Z"), error: "приёмник недоступен" });
    expect(repository.states.get("last")).toMatchObject({ status: "failed", attempts: RETRY_DELAYS_MIN.length + 1, nextAt: null });
  });

  it("назначения нет в реестре — пропущено с прежней причиной unknown_network, сеть не спрашивается", async () => {
    const { repository, service } = setup();
    repository.queue = [due({ destination: "partner" }), due({ conversionId: "c2", destination: "s2s" })];
    const { urls, fetchImpl } = fakeFetch(() => new Response("", { status: 200 }));
    const report = await service.tick(NOW, fetchImpl);
    expect(urls).toEqual([]);
    expect(report).toMatchObject({ skipped: 2, sent: 0 });
    expect(repository.states.get("c1")).toMatchObject({ status: "skipped", reason: "unknown_network" });
    expect(repository.states.get("c2")).toMatchObject({ status: "skipped", reason: "unknown_network" });
  });

  it("назначение не принимает событие — пропущено до подготовки запроса; AdsGram возврата не получает", async () => {
    const destination = new FakeDestination("s2s", ["registration"], { kind: "request", url: new URL(SECRET_URL), logUrl: SAFE_URL });
    const { repository, service } = setup(TOKEN, [destination, new AdsgramDestination(secretsWith(TOKEN))]);
    repository.queue = [due({ conversionId: "s2s-return", destination: "s2s", event: "d1_return" }), due({ conversionId: "ads-return", event: "d1_return" })];
    const { urls, fetchImpl } = fakeFetch(() => new Response("", { status: 200 }));
    await service.tick(NOW, fetchImpl);
    expect(urls).toEqual([]);
    expect(destination.prepared).toEqual([]);
    expect(repository.states.get("s2s-return")).toMatchObject({ status: "skipped", reason: "unknown_network" });
    expect(repository.states.get("ads-return")).toMatchObject({ status: "skipped", reason: "unknown_network" });
  });

  it("назначение ждёт настройки — отложено на его срок, попытка не тратится", async () => {
    const destination = new FakeDestination("s2s", ALL_EVENTS, { kind: "wait", reason: "no_template", recheckMin: 7 });
    const { repository, service } = setup(TOKEN, [destination]);
    repository.queue = [due({ destination: "s2s", attempts: 3 })];
    const { urls, fetchImpl } = fakeFetch(() => new Response("", { status: 200 }));
    const report = await service.tick(NOW, fetchImpl);
    expect(urls).toEqual([]);
    expect(report).toMatchObject({ deferred: 1 });
    expect(repository.states.get("c1")).toMatchObject({ status: "pending", attempts: 0, reason: "no_template", nextAt: new Date("2026-10-02T12:07:00.000Z") });
  });

  it("назначение пропустило само — причина его, сеть не спрашивается", async () => {
    const destination = new FakeDestination("partner", ALL_EVENTS, { kind: "skip", reason: "no_click_id" });
    const { repository, service } = setup(TOKEN, [destination]);
    repository.queue = [due({ destination: "partner" })];
    const { urls, fetchImpl } = fakeFetch(() => new Response("", { status: 200 }));
    await service.tick(NOW, fetchImpl);
    expect(urls).toEqual([]);
    expect(repository.states.get("c1")).toMatchObject({ status: "skipped", reason: "no_click_id" });
  });

  it("запрос назначения уходит как задан: метод, заголовки и тело; срок ожидания ставит сервис, сигнал назначения не теряется", async () => {
    const own = new AbortController();
    const destination = new FakeDestination("s2s", ALL_EVENTS, {
      kind: "request",
      url: new URL("https://hook.example.test/in"),
      init: { method: "POST", headers: { "content-type": "application/json" }, body: '{"event":"registration"}', signal: own.signal },
      logUrl: "https://hook.example.test/in",
    });
    const { repository, service } = setup(TOKEN, [destination]);
    repository.queue = [due({ destination: "s2s" })];
    const seen: { input: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      seen.push({ input: String(input), init });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await service.tick(NOW, fetchImpl);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toBe("https://hook.example.test/in");
    expect(seen[0]?.init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" }, body: '{"event":"registration"}' });
    const signal = seen[0]?.init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    own.abort();
    expect(signal?.aborted).toBe(true);
    expect(repository.states.get("c1")).toMatchObject({ status: "sent", httpStatus: 200 });
  });

  it("в лог идёт logUrl, адрес с секретом — никогда: ни при отказе сети, ни при её недоступности", async () => {
    const lines = captureLog();
    const destination = new FakeDestination("s2s", ALL_EVENTS, { kind: "request", url: new URL(SECRET_URL), logUrl: SAFE_URL });
    const { repository, service } = setup(TOKEN, [destination]);
    repository.queue = [due({ conversionId: "refused", destination: "s2s" })];
    await service.tick(NOW, fakeFetch(() => new Response("busy", { status: 503 })).fetchImpl);
    repository.queue = [due({ conversionId: "down", destination: "s2s" })];
    await service.tick(NOW, fakeFetch(() => Promise.reject(new Error("connect ECONNREFUSED"))).fetchImpl);

    const log = lines.join("\n");
    expect(log).toContain(SAFE_URL);
    expect(log).toContain("postback_rejected");
    expect(log).toContain("postback_failed");
    expect(log).not.toContain("SECRET_VALUE");
    expect(JSON.stringify([...repository.states.values()])).not.toContain("SECRET_VALUE");
  });

  it("токен AdsGram не попадает ни в лог, ни в журнал конверсий", async () => {
    const lines = captureLog();
    const { repository, service } = setup();
    repository.queue = [due({ conversionId: "bad" }), due({ conversionId: "down" })];
    await service.tick(NOW, fakeFetch((url) => (repository.states.size === 0 && url.includes("record") ? new Response("invalid", { status: 400 }) : Promise.reject(new Error("socket hang up")))).fetchImpl);
    expect(lines.join("\n")).toContain("token=***");
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(JSON.stringify([...repository.states.values()])).not.toContain(TOKEN);
  });

  it("назначение упало при подготовке — конверсия повторится по расписанию, очередь не встаёт", async () => {
    const lines = captureLog();
    const broken = new FakeDestination("s2s", ALL_EVENTS, async () => {
      throw new Error("шаблон не разобрался");
    });
    const { repository, service } = setup(TOKEN, [broken, new AdsgramDestination(secretsWith(TOKEN))]);
    repository.queue = [due({ conversionId: "broken", destination: "s2s" }), due({ conversionId: "fine" })];
    const { urls, fetchImpl } = fakeFetch(() => new Response("ok", { status: 200 }));
    const report = await service.tick(NOW, fetchImpl);
    expect(report).toMatchObject({ sent: 1, deferred: 1 });
    expect(urls).toHaveLength(1);
    expect(repository.states.get("broken")).toMatchObject({ status: "pending", attempts: 1, nextAt: new Date("2026-10-02T12:01:00.000Z") });
    expect(repository.states.get("broken")?.error).toContain("шаблон не разобрался");
    expect(repository.states.get("fine")).toMatchObject({ status: "sent" });
    expect(lines.join("\n")).toContain("postback_prepare_failed");
  });

  it("несколько назначений: каждая конверсия уходит своему, по виду назначения", async () => {
    const other = new FakeDestination("partner", ALL_EVENTS, { kind: "request", url: new URL("https://partner.example.test/cb?click=1"), logUrl: "https://partner.example.test/cb?click=1" });
    const { repository, service } = setup(TOKEN, [new AdsgramDestination(secretsWith(TOKEN)), other]);
    repository.queue = [due({ conversionId: "ads" }), due({ conversionId: "ptn", destination: "partner", event: "purchase_first" })];
    const { urls, fetchImpl } = fakeFetch(() => new Response("ok", { status: 200 }));
    const report = await service.tick(NOW, fetchImpl);
    expect(report).toMatchObject({ sent: 2 });
    expect(urls).toEqual([`https://api.adsgram.ai/confirm_conversion?token=${TOKEN}&record=7f3a1b6c&goaltype=1`, "https://partner.example.test/cb?click=1"]);
    expect(other.prepared).toEqual(["ptn"]);
  });

  it("отправка идёт общим клиентом с меткой ads.postback; fetch теста сильнее клиента", async () => {
    const services: string[] = [];
    const clientUrls: string[] = [];
    const outbound = {
      forService: (name: string) => {
        services.push(name);
        return (async (input: URL | string) => {
          clientUrls.push(String(input));
          return new Response("ok", { status: 200 });
        }) as typeof fetch;
      },
    } as unknown as Outbound;

    const viaClient = setup(TOKEN, undefined, outbound);
    viaClient.repository.queue = [due()];
    await viaClient.service.tick(NOW);
    expect(services).toEqual(["ads.postback"]);
    expect(clientUrls).toHaveLength(1);
    expect(viaClient.repository.states.get("c1")).toMatchObject({ status: "sent" });

    const viaTest = setup(TOKEN, undefined, outbound);
    viaTest.repository.queue = [due()];
    const { urls, fetchImpl } = fakeFetch(() => new Response("ok", { status: 200 }));
    await viaTest.service.tick(NOW, fetchImpl);
    expect(urls).toHaveLength(1);
    expect(clientUrls).toHaveLength(1);
  });

  it("два назначения одного вида в реестре — ошибка при сборке: иначе конверсию взяло бы любое", () => {
    const first = new FakeDestination("s2s", ALL_EVENTS, { kind: "skip", reason: "x" });
    const second = new FakeDestination("s2s", ALL_EVENTS, { kind: "skip", reason: "x" });
    expect(() => setup(TOKEN, [first, second])).toThrow(/s2s/);
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
