import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  CODE_ALPHABET,
  audienceText,
  batchMask,
  checkCode,
  codesCsv,
  createBodyOf,
  createPromoCode,
  emptyForm,
  fetchPromoCodes,
  formOf,
  formSchema,
  layoutHint,
  randomCode,
  removePromoCode,
  rewardText,
  setPaused,
  updateBodyOf,
  type PromoCampaign,
  type PromoCodeForm,
  type PromoCodeLimits,
} from "../src/api/promo-codes";
import { formatNumber, localInput, plural } from "../src/format";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Промокоды в панели (docs/35-stage4-plan.md WP41): форма проверяет пределы
// сервера у своих полей, время уходит в UTC, правка не трогает то, что после
// активаций и начала не меняется.

const LIMITS: PromoCodeLimits = {
  reward: { coins: 50_000, gems: 300, shard_common: 200, shard_uncommon: 50 },
  codeMinLength: 4,
  codeMaxLength: 24,
  prefixMaxLength: 8,
  batchMax: 1_000,
  maxRedemptions: 1_000_000,
  newPlayersMaxDays: 90,
  aheadDays: 90,
  minHours: 1,
  titleMax: 80,
  noteMax: 200,
  messageMax: 160,
};
const NOW = new Date(2026, 9, 2, 12, 0);
const DAY = 86_400_000;

function campaign(patch: Partial<PromoCampaign> = {}): PromoCampaign {
  return {
    campaignId: "0c4a5c1e-6a57-4d43-8a2a-0f3f6d0a9b10",
    title: "Стрим",
    kind: "shared",
    reward: { coins: 1_000, gems: 20, shard_common: 0, shard_uncommon: 0 },
    message: null,
    maxRedemptions: null,
    redeemed: 0,
    startsAt: new Date(NOW.getTime() - DAY).toISOString(),
    endsAt: new Date(NOW.getTime() + 6 * DAY).toISOString(),
    newPlayersDays: null,
    platforms: [],
    pausedAt: null,
    note: null,
    createdBy: "a",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    codeSample: "РУБЕЖ 2026",
    partnerId: null,
    partnerName: null,
    state: "active",
    remaining: null,
    ...patch,
  };
}

function form(patch: Partial<PromoCodeForm> = {}): PromoCodeForm {
  return { ...emptyForm(NOW), code: "РУБЕЖ2026", title: "Стрим 12 октября", ...patch };
}

function problems(value: PromoCodeForm, editing: PromoCampaign | null = null): Record<string, string> {
  const result = formSchema(LIMITS, () => NOW, editing).safeParse(value);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((issue) => [issue.path.join("."), issue.message]));
}

describe("промокоды в панели", () => {
  it("раздел — под своим правом", () => {
    expect(SECTIONS.find((section) => section.id === "promo-codes")?.permission).toBe("promo.edit");
  });

  it("список, проверка кода, заведение, пауза и удаление — по своим адресам", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { campaigns: [campaign()], limits: LIMITS, platforms: ["telegram", "max", "vk", "web"], partners: [], partnerRules: { bindWindowDays: 7 } } }),
      json(200, { data: { display: "РУБЕЖ 2026", key: "PYБEЖ2026", problem: null, taken: null } }),
      json(201, { data: campaign() }),
      json(201, { data: campaign({ state: "paused" }) }),
      json(201, { data: { removed: true } }),
    );
    const api = new AdminApi(fetch);
    const list = await fetchPromoCodes(api);
    expect(list.ok && list.data.campaigns[0]?.codeSample).toBe("РУБЕЖ 2026");
    expect(calls[0]?.url).toBe("/api/v1/admin/promo-codes");

    await checkCode(api, "рубеж 2026");
    expect(calls[1]?.url).toBe(`/api/v1/admin/promo-codes/check?${new URLSearchParams({ code: "рубеж 2026" }).toString()}`);

    await createPromoCode(api, createBodyOf(form(), NOW));
    expect(calls[2]?.init.method).toBe("POST");
    const body = JSON.parse(String(calls[2]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ title: "Стрим 12 октября", note: null, message: null, startsAt: NOW.toISOString(), issue: { kind: "shared", code: "РУБЕЖ2026", maxRedemptions: null }, partnerId: null });
    expect(createBodyOf(form({ partnerId: "p-1" }), NOW).partnerId).toBe("p-1");

    const paused = await setPaused(api, "x-1", true);
    expect(paused.ok && paused.data.state).toBe("paused");
    expect(calls[3]?.url).toBe("/api/v1/admin/promo-codes/x-1/pause");
    await removePromoCode(api, "x-1");
    expect(calls[4]?.url).toBe("/api/v1/admin/promo-codes/x-1/remove");
  });

  it("форма по умолчанию проходит; ошибки — у своих полей и словами", () => {
    expect(problems(form())).toEqual({});
    expect(problems(form({ code: "" })).code).toMatch(/Придумайте код/);
    expect(problems(form({ code: "ab-c" })).code).toMatch(/Не короче 4/);
    expect(problems(form({ reward: { coins: 0, gems: 0, shard_common: 0, shard_uncommon: 0 } }))["reward.coins"]).toMatch(/без награды/);
    expect(problems(form({ reward: { coins: 60_000, gems: 0, shard_common: 0, shard_uncommon: 0 } }))["reward.coins"]).toBe(`От 0 до ${formatNumber(50_000)}`);
    expect(problems(form({ unlimited: false, maxRedemptions: 0 })).maxRedemptions).toBeDefined();
    expect(problems(form({ startMode: "at", startsAt: localInput(new Date(NOW.getTime() - DAY)) })).startsAt).toMatch(/в прошлом/);
    expect(problems(form({ startMode: "at", startsAt: localInput(new Date(NOW.getTime() + 100 * DAY)) })).startsAt).toMatch(/90 дней/);
    expect(problems(form({ endsAt: localInput(new Date(NOW.getTime() + 30 * 60_000)) })).endsAt).toMatch(/хотя бы час/);
    expect(problems(form({ endMode: "never", endsAt: "" }))).toEqual({});
    expect(problems(form({ newOnly: true, newPlayersDays: 120 })).newPlayersDays).toBeDefined();
    expect(problems(form({ title: "x" })).title).toMatch(/Назовите код/);
    expect(problems(form({ kind: "batch", count: 0 })).count).toBeDefined();
    expect(problems(form({ kind: "batch", count: 10, prefix: "ZIMA 26" })).prefix).toMatch(/Одно слово/);
    expect(problems(form({ kind: "batch", count: 10, prefix: "ЗИМА" }))).toEqual({});
  });

  it("правка: активированный код — без проверки награды, лимит не ниже активаций; начавшийся — начало уходит прежним", () => {
    const used = campaign({ redeemed: 5, maxRedemptions: 10 });
    const draft = formOf(used);
    expect(draft).toMatchObject({ kind: "shared", unlimited: false, maxRedemptions: 10, startMode: "at", endMode: "at" });
    expect(problems({ ...draft, maxRedemptions: 3 }, used).maxRedemptions).toMatch(/Не меньше уже сделанных активаций — 5/);
    // Награда заблокирована на экране; форма её не проверяет, сервер — сверит.
    expect(problems({ ...draft, reward: { coins: 0, gems: 0, shard_common: 0, shard_uncommon: 0 } }, used)).toEqual({});

    const body = updateBodyOf({ ...draft, startsAt: localInput(new Date(NOW.getTime() + DAY)), title: "Новое" }, used, NOW);
    expect(body).toMatchObject({ title: "Новое", startsAt: used.startsAt, maxRedemptions: 10 });
    // Вид, код и партнёр после заведения не меняются — правка их не шлёт.
    expect("issue" in body).toBe(false);
    expect("partnerId" in body).toBe(false);
    expect(formOf(campaign({ partnerId: "p-1", partnerName: "Канал" })).partnerId).toBe("p-1");

    const batch = campaign({ kind: "batch", maxRedemptions: 50, codeSample: "ZIMA-K7MP-3XTE" });
    expect(updateBodyOf({ ...formOf(batch), unlimited: true }, batch, NOW).maxRedemptions).toBe(50);
    // Кончившийся код переименовывается: конец в прошлом не трогали.
    const ended = campaign({ endsAt: new Date(NOW.getTime() - DAY).toISOString(), startsAt: new Date(NOW.getTime() - 3 * DAY).toISOString() });
    expect(problems({ ...formOf(ended), title: "Архив" }, ended)).toEqual({});
    expect(problems({ ...formOf(ended), endsAt: localInput(new Date(NOW.getTime() - 2 * DAY)) }, ended).endsAt).toMatch(/в прошлом/);
  });

  it("награда, кому и пачка — словами и с правильными склонениями", () => {
    expect(rewardText({ coins: 1_000, gems: 21, shard_common: 3, shard_uncommon: 0 })).toBe(`${formatNumber(1_000)} монет · 21 самоцвет · 3 обычных осколка`);
    expect(rewardText({ coins: 0, gems: 0, shard_common: 0, shard_uncommon: 1 })).toBe("1 необычный осколок");
    expect(rewardText({ coins: 0, gems: 0, shard_common: 0, shard_uncommon: 0 })).toBe("ничего");
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111].map((count) => plural(count, ["монета", "монеты", "монет"]))).toEqual(["монета", "монеты", "монет", "монет", "монет", "монета", "монеты", "монет", "монет"]);
    expect(audienceText({ platforms: [], newPlayersDays: null })).toBe("все игроки");
    expect(audienceText({ platforms: ["telegram", "vk"], newPlayersDays: 7 })).toBe("новички до 7 дней · Telegram, VK");
    expect(audienceText({ platforms: [], newPlayersDays: 1 })).toBe("новички до 1 дня");
    expect(batchMask("ZIMA-K7MP-3XTE")).toBe("ZIMA-····-····");
    expect(batchMask("K7MP-3XTE")).toBe("····-····");
    expect(batchMask("ЗИМА-K7MP-3XTE")).toBe("ЗИМА-····-····");
  });

  it("подсказка раскладки: русское слово — только по-русски, английское — по-английски, двойники — с любой", () => {
    expect(layoutHint("РУБЕЖ 2026")).toMatchObject({ tone: "info", text: expect.stringContaining("русской раскладке") as unknown });
    expect(layoutHint("RUBEZH2026")).toMatchObject({ tone: "info", text: expect.stringContaining("английской раскладке") as unknown });
    expect(layoutHint("PEKA-2026")).toMatchObject({ tone: "info", text: expect.stringContaining("с любой") as unknown });
    expect(layoutHint("ЗИМА-WIN")).toMatchObject({ tone: "warning" });
  });

  it("придуманный код — из букв обеих раскладок; выгрузка пачки — таблицей для Excel", () => {
    const code = randomCode(8, (size) => size - 1);
    expect(code).toBe("9".repeat(8));
    for (const letter of randomCode(64)) expect(CODE_ALPHABET).toContain(letter);
    expect(codesCsv([{ display: "ZIMA-K7MP-3XTE", redeemedAt: null }, { display: "ZIMA-AAAA-CCCC", redeemedAt: "2026-10-02T09:00:00.000Z" }]).split("\r\n")).toEqual([
      "код;активирован;когда (UTC)",
      "ZIMA-K7MP-3XTE;нет;",
      "ZIMA-AAAA-CCCC;да;2026-10-02T09:00:00.000Z",
    ]);
  });
});
