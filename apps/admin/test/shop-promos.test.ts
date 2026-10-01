import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { cancelPromo, createPromo, draftProblem, emptyDraft, fetchPromos, promoPrice, promoRequest, type PromoDraft, type PromoLimits } from "../src/api/shop-promos";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Акции магазина в панели (docs/35-stage4-plan.md WP10, часть 8): форма
// проверяет пределы сервера, время уходит в UTC, предпросмотр цены — тем же
// правилом, что сервер.

const LIMITS: PromoLimits = { minPercent: 5, maxPercent: 80, minHours: 1, maxDays: 14, restDays: 14, aheadDays: 60 };
const NOW = new Date(Date.UTC(2026, 9, 1, 9));

function draft(patch: Partial<PromoDraft> = {}): PromoDraft {
  return { sku: "gems_330", percent: 30, startsAt: "", days: 3, title: "", ...patch };
}

function promo(patch: Record<string, unknown> = {}) {
  return {
    promoId: "0c4a5c1e-6a57-4d43-8a2a-0f3f6d0a9b10",
    sku: "gems_330",
    percent: 30,
    startsAt: NOW.toISOString(),
    endsAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString(),
    title: null,
    createdAt: NOW.toISOString(),
    createdBy: "a",
    cancelledAt: null,
    cancelledBy: null,
    state: "active",
    ...patch,
  };
}

describe("акции в панели", () => {
  it("раздел — под своим правом", () => {
    expect(SECTIONS.find((section) => section.id === "promos")?.permission).toBe("shop.promo.edit");
  });

  it("список, заведение и снятие — по своим адресам; пустая подпись — null, «сразу» — время отправки", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { promos: [promo()], skus: [{ sku: "gems_330", title: "330 самоцветов", kind: "gems", stars: 250 }], limits: LIMITS } }),
      json(201, { data: promo() }),
      json(201, { data: promo({ state: "cancelled", cancelledAt: NOW.toISOString(), cancelledBy: "a" }) }),
    );
    const api = new AdminApi(fetch);
    const list = await fetchPromos(api);
    expect(list.ok && list.data.skus[0]?.stars).toBe(250);
    expect(calls[0]?.url).toBe("/api/v1/admin/shop/promos");

    await createPromo(api, draft({ title: "   " }), NOW);
    expect(calls[1]?.url).toBe("/api/v1/admin/shop/promos");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      sku: "gems_330",
      percent: 30,
      startsAt: NOW.toISOString(),
      endsAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString(),
      title: null,
    });

    const cancelled = await cancelPromo(api, "0c4a5c1e-6a57-4d43-8a2a-0f3f6d0a9b10");
    expect(cancelled.ok && cancelled.data.state).toBe("cancelled");
    expect(calls[2]?.url).toBe("/api/v1/admin/shop/promos/0c4a5c1e-6a57-4d43-8a2a-0f3f6d0a9b10/cancel");
  });

  it("начало из поля формы — часы браузера, на сервер — абсолютное время", () => {
    const local = "2026-10-05T12:00";
    const request = promoRequest(draft({ startsAt: local, days: 2, title: " Неделя " }), NOW);
    expect(request.startsAt).toBe(new Date(local).toISOString());
    expect(new Date(request.endsAt).getTime() - new Date(request.startsAt).getTime()).toBe(2 * 86_400_000);
    expect(request.title).toBe("Неделя");
  });

  it("форма не пропустит скидку и срок вне пределов, начало в прошлом и слишком далеко", () => {
    expect(draftProblem(draft(), LIMITS, NOW)).toBeNull();
    expect(draftProblem(draft({ sku: "" }), LIMITS, NOW)).toMatch(/товар/);
    for (const percent of [4, 81, 12.5, Number.NaN]) expect(draftProblem(draft({ percent }), LIMITS, NOW), String(percent)).toMatch(/Скидка/);
    for (const days of [0, 15, Number.NaN]) expect(draftProblem(draft({ days }), LIMITS, NOW), String(days)).toMatch(/Акция идёт/);
    expect(draftProblem(draft({ startsAt: "2026-09-01T10:00" }), LIMITS, NOW)).toMatch(/прошлом/);
    expect(draftProblem(draft({ startsAt: "2027-01-01T10:00" }), LIMITS, NOW)).toMatch(/60 дней/);
    expect(draftProblem(draft({ title: "я".repeat(49) }), LIMITS, NOW)).toMatch(/Подпись/);
  });

  it("предпросмотр цены — вниз до целой звезды, не ниже одной; пустая форма берёт первый товар", () => {
    expect(promoPrice(250, 30)).toBe(175);
    expect(promoPrice(50, 33)).toBe(33);
    expect(promoPrice(2, 80)).toBe(1);
    expect(emptyDraft([{ sku: "starter", title: "Стартовый набор", kind: "starter", stars: 50 }]).sku).toBe("starter");
    expect(emptyDraft([]).sku).toBe("");
  });
});
