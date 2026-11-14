import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { EMBLEM_NOT_FOUND, EMBLEM_NOT_HELD, createEmblemsApi, emblemFailure, publicEmblemSchema } from "../src/state/emblems-api";

// Клиент раздела «Знаки» (tasks/T-0236, tasks/T-0235): ответ сервера — граница
// системы и разбирается схемой; закрытый знак приходит с условием и, может
// быть, без процента.

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function server(sent: Sent[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> => {
    sent.push({ method: init?.method ?? "GET", path, body: init?.body });
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const HELD = { id: "emb_tester", title: "Тестер", hint: "Играл на закрытом тесте", category: "status", tier: "rare", held: true, percent: 4.2 };
const SEASON = { id: "emb_season_champion", title: "Чемпион", hint: "Первое место в сезоне", category: "season", tier: "mythic", held: true, season: 3, percent: null };
const CLOSED = { id: "ach_boss_25", title: "Охотник на боссов", hint: "Победи 25 боссов", category: "merit", tier: "epic", held: false, percent: 1.5 };

describe("раздел «Знаки»", () => {
  it("ответ с держимым, закрытым и сезонным знаком разбирается; запрос — GET без тела", async () => {
    const sent: Sent[] = [];
    const response = await createEmblemsApi(server(sent, { shown: "emb_tester", auto: true, items: [HELD, SEASON, CLOSED] })).load();

    expect(sent).toEqual([{ method: "GET", path: "/api/v1/achievements/emblems", body: undefined }]);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.shown).toBe("emb_tester");
    expect(response.data.auto).toBe(true);
    expect(response.data.items.map((entry) => entry.held)).toEqual([true, true, false]);
    expect(response.data.items[1]).toMatchObject({ season: 3, percent: null });
    expect(response.data.items[2]).toMatchObject({ hint: "Победи 25 боссов", percent: 1.5 });
  });

  it("ответ без `percent` и без `hint` разбирается: население ниже порога", async () => {
    const bare: Record<string, unknown> = { ...CLOSED };
    delete bare.percent;
    delete bare.hint;

    const response = await createEmblemsApi(server([], { shown: null, auto: true, items: [bare] })).load();

    expect(response.ok).toBe(true);
    const first = response.ok ? response.data.items[0] : undefined;
    expect(first?.percent ?? null).toBeNull();
    expect(first?.hint ?? null).toBeNull();
  });

  it("незнакомая категория и редкость не роняют раздел: сервер новее клиента", async () => {
    const response = await createEmblemsApi(server([], { shown: null, auto: true, items: [{ ...CLOSED, category: "legacy", tier: "cosmic" }] })).load();

    expect(response.ok).toBe(true);
  });

  it("битый ответ — отказ схемы, а не молча пустой раздел", async () => {
    const noItems = await createEmblemsApi(server([], { shown: null, auto: true })).load();
    const badHeld = await createEmblemsApi(server([], { shown: null, auto: true, items: [{ ...HELD, held: "да" }] })).load();

    expect(noItems.ok).toBe(false);
    expect(badHeld.ok).toBe(false);
  });
});

describe("выбор знака", () => {
  it("знак выбирается PUT с `id`; ответ — что показывается теперь", async () => {
    const sent: Sent[] = [];

    const response = await createEmblemsApi(server(sent, { shown: "ach_boss_25", auto: false })).choose("ach_boss_25");

    expect(sent).toEqual([{ method: "PUT", path: "/api/v1/achievements/emblem", body: { id: "ach_boss_25" } }]);
    expect(response.ok && response.data).toEqual({ shown: "ach_boss_25", auto: false });
  });

  it("«По умолчанию» — PUT с `id: null`", async () => {
    const sent: Sent[] = [];

    const response = await createEmblemsApi(server(sent, { shown: "emb_tester", auto: true })).choose(null);

    expect(sent).toEqual([{ method: "PUT", path: "/api/v1/achievements/emblem", body: { id: null } }]);
    expect(response.ok && response.data.auto).toBe(true);
  });

  it("409 с кодом `emblem_not_held` доходит до экрана кодом, а не обезличенным отказом", async () => {
    const refusing: ApiRequest = async <T,>(): Promise<ApiResult<T>> => ({ ok: false, failure: "unavailable", code: "emblem_not_held" });

    const response = await createEmblemsApi(refusing).choose("emb_vip");

    expect(response).toEqual({ ok: false, failure: "unavailable", code: EMBLEM_NOT_HELD });
    expect(EMBLEM_NOT_HELD).toBe("emblem_not_held");
    expect(EMBLEM_NOT_FOUND).toBe("emblem_not_found");
  });

  it("оба кода отказа — «состояние разошлось, перечитай»; прочие — нет; текст один", () => {
    expect(emblemFailure("emblem_not_held")).toEqual({ textKey: "emblems.chooseFailed", reload: true });
    expect(emblemFailure("emblem_not_found")).toEqual({ textKey: "emblems.chooseFailed", reload: true });
    expect(emblemFailure("rate_limited")).toEqual({ textKey: "emblems.chooseFailed", reload: false });
    expect(emblemFailure(undefined)).toEqual({ textKey: "emblems.chooseFailed", reload: false });
  });
});

describe("знак в строке списка", () => {
  it("с номером сезона и без него разбирается; незнакомая редкость не падает", () => {
    const parse = (value: unknown) => publicEmblemSchema.safeParse(value).success;

    expect(parse({ id: "emb_vip", title: "VIP", tier: "legendary", category: "status" })).toBe(true);
    expect(parse({ id: "emb_season_top10", title: "Топ-10", tier: "epic", category: "season", season: 2 })).toBe(true);
    expect(parse({ id: "x", title: "Знак", tier: "cosmic", category: "merit" })).toBe(true);
    expect(parse({ id: "x", title: 5, tier: "rare", category: "merit" })).toBe(false);
  });
});
