import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { PARTNER_CODE_ROUTE, createPartner, emptyPartnerForm, fetchPartner, fetchPartners, partnerFormOf, partnerFormSchema, partnerOfRoute, share, updatePartner } from "../src/api/partners";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Партнёры в панели (docs/35-stage4-plan.md WP41, часть 2): адреса и тела
// запросов, пустые поля формы уходят как null, доли без деления на ноль и
// маршрут мастера промокода с выбранным партнёром.

const PARTNER = {
  partnerId: "0c4a5c1e-6a57-4d43-8a2a-0f3f6d0a9b10",
  name: "Канал",
  contact: "@channel",
  note: null,
  createdAt: "2026-10-02T09:00:00.000Z",
  updatedAt: "2026-10-02T09:00:00.000Z",
  stats: { codes: 1, activeCodes: 1, redeemed: 10, bound: 4, played: 3, payers: 1, stars: 250 },
};

describe("партнёры в панели", () => {
  it("раздел — под правом смотреть партнёров", () => {
    expect(SECTIONS.find((section) => section.id === "partners")?.permission).toBe("partners.view");
  });

  it("список, карточка, заведение и правка — по своим адресам; пустые связь и заметка — null", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { partners: [PARTNER], rules: { bindWindowDays: 7 } } }),
      json(200, { data: { partner: PARTNER, daily: [{ day: "2026-10-02", count: 4 }], codes: [], rules: { bindWindowDays: 7 } } }),
      json(201, { data: PARTNER }),
      json(201, { data: { ...PARTNER, name: "Канал 2" } }),
    );
    const api = new AdminApi(fetch);
    const list = await fetchPartners(api);
    expect(list.ok && list.data.partners[0]?.stats.bound).toBe(4);
    expect(calls[0]?.url).toBe("/api/v1/admin/partners");
    const detail = await fetchPartner(api, PARTNER.partnerId);
    expect(detail.ok && detail.data.daily).toHaveLength(1);
    expect(calls[1]?.url).toBe(`/api/v1/admin/partners/${PARTNER.partnerId}`);

    await createPartner(api, { name: " Канал ", contact: "", note: "  " });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ name: "Канал", contact: null, note: null });
    await updatePartner(api, PARTNER.partnerId, { ...partnerFormOf(PARTNER), name: "Канал 2" });
    expect(calls[3]?.url).toBe(`/api/v1/admin/partners/${PARTNER.partnerId}`);
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ name: "Канал 2", contact: "@channel", note: null });
  });

  it("форма: имя обязательно и не длиннее 80; пустая форма — для нового", () => {
    expect(emptyPartnerForm()).toEqual({ name: "", contact: "", note: "" });
    expect(partnerFormSchema.safeParse({ name: "К", contact: "", note: "" }).success).toBe(false);
    expect(partnerFormSchema.safeParse({ name: "x".repeat(81), contact: "", note: "" }).success).toBe(false);
    expect(partnerFormSchema.safeParse({ name: "Канал", contact: "", note: "" }).success).toBe(true);
  });

  it("доля от приведённых — процентом, от нуля — прочерк; маршрут мастера с партнёром разбирается обратно", () => {
    expect(share(3, 4)).toBe("75%");
    expect(share(0, 0)).toBe("—");
    expect(partnerOfRoute(`${PARTNER_CODE_ROUTE}${PARTNER.partnerId}`)).toBe(PARTNER.partnerId);
    expect(partnerOfRoute(null)).toBeNull();
    expect(partnerOfRoute(PARTNER.partnerId)).toBeNull();
  });
});
