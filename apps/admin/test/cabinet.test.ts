import { describe, expect, it } from "vitest";
import {
  CABINET_LIMITS,
  CABINET_TEXTS,
  LINK_SOURCES,
  SOURCE_TITLES,
  codeProblem,
  copyBlockedReason,
  copyCabinetPromo,
  createCabinetLink,
  emptyLinkForm,
  fetchCabinetLinks,
  fetchCabinetPromos,
  linkFormProblems,
  redeemedText,
  setCabinetOpen,
  viewBanner,
  type CabinetPromo,
} from "../src/api/cabinet";
import { AdminApi } from "../src/api/client";
import { fetchPartner } from "../src/api/partners";
import { SECTIONS, locateSection, resolveRoute, visibleGroups } from "../src/routes";
import { SECTION_SCREENS } from "../src/screens/sections";
import { fakeFetch, json } from "./helpers";

// Кабинет партнёра в панели (docs/35-stage4-plan.md Р136, tasks/T-0218): адреса и тела запросов, проверка форм
// без сервера, режим «глазами партнёра» и вход партнёра сразу в «Кабинет».

const LINK = { code: "abc123def456", url: "https://rubezh.example/r/abc123def456", campaign: "moy-kanal", source: "channel", note: null, createdAt: "2026-10-24T09:00:00.000Z", clicks: 4, launches: 2 };
const PROMO: CabinetPromo = {
  campaignId: "7b0c0f6e-0d6c-4a52-9a0e-3f2b9a1c1d11",
  kind: "shared",
  code: "KANAL 2026",
  reward: { coins: 500, gems: 5, shard_common: 0, shard_uncommon: 0 },
  redeemed: 12,
  maxRedemptions: 300,
  startsAt: "2026-10-24T08:00:00.000Z",
  endsAt: null,
  state: "active",
  copy: false,
};

describe("запросы кабинета", () => {
  it("свой кабинет — без partnerId, чужой глазами партнёра — с ним; ответ разбирается схемой", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { links: [LINK], limit: { used: 1, max: 20 }, viewOnly: false } }),
      json(200, { data: { links: [], limit: { used: 0, max: 20 }, viewOnly: true } }),
      json(200, { data: { promos: [PROMO], copies: { used: 0, max: 5 }, viewOnly: false } }),
    );
    const api = new AdminApi(fetch);

    const own = await fetchCabinetLinks(api, null);
    const watched = await fetchCabinetLinks(api, "p-1");
    const promos = await fetchCabinetPromos(api, null);

    expect(calls.map((call) => call.url)).toEqual(["/api/v1/admin/cabinet/links", "/api/v1/admin/cabinet/links?partnerId=p-1", "/api/v1/admin/cabinet/promos"]);
    expect(own.ok && own.data.links[0]?.launches).toBe(2);
    expect(watched.ok && watched.data.viewOnly).toBe(true);
    expect(promos.ok && promos.data.promos[0]?.reward.gems).toBe(5);
  });

  it("новая ссылка уходит названием, источником и заметкой — пустая заметка как null; больше полей в теле нет", async () => {
    const { fetch, calls } = fakeFetch(json(201, { data: LINK }));
    const api = new AdminApi(fetch);

    const result = await createCabinetLink(api, { campaign: "  Мой канал ", source: "stream", note: "   " });

    expect(result.ok).toBe(true);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ campaign: "Мой канал", source: "stream", note: null });
  });

  it("копия промокода — только новое слово, награды и лимита в теле нет", async () => {
    const { fetch, calls } = fakeFetch(json(201, { data: { ...PROMO, copy: true, code: "NOVOE SLOVO" } }));

    const result = await copyCabinetPromo(new AdminApi(fetch), PROMO.campaignId, " novoe slovo ");

    expect(result.ok && result.data.copy).toBe(true);
    expect(calls[0]?.url).toBe(`/api/v1/admin/cabinet/promos/${PROMO.campaignId}/copy`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: "novoe slovo" });
  });

  it("отказ сервера («это потолок кабинета») доходит текстом; открыть и закрыть кабинет — запрос из карточки партнёра", async () => {
    const { fetch, calls } = fakeFetch(
      json(400, { error: { code: "validation_failed", message: "Ссылок уже 20 — это потолок кабинета" } }),
      json(201, { data: { accountId: "a-1", open: true } }),
    );
    const api = new AdminApi(fetch);

    const refused = await createCabinetLink(api, { campaign: "Лишняя", source: "post", note: "" });
    const opened = await setCabinetOpen(api, "p-1", true);

    expect(!refused.ok && refused.error.message).toBe("Ссылок уже 20 — это потолок кабинета");
    expect(!refused.ok && refused.error.kind).toBe("rejected");
    expect(calls[1]?.url).toBe("/api/v1/admin/partners/p-1/cabinet");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ open: true });
    expect(opened.ok && opened.data).toEqual({ accountId: "a-1", open: true });
  });

  it("карточка партнёра отдаёт состояние кабинета; сервер старее — «не открывался»", async () => {
    const detail = { partner: partner(), daily: [], codes: [], rules: { bindWindowDays: 7 } };
    const { fetch } = fakeFetch(json(200, { data: { ...detail, cabinet: { accountId: "a-1", open: true } } }), json(200, { data: detail }));
    const api = new AdminApi(fetch);

    const withCabinet = await fetchPartner(api, "p-1");
    const old = await fetchPartner(api, "p-1");

    expect(withCabinet.ok && withCabinet.data.cabinet).toEqual({ accountId: "a-1", open: true });
    expect(old.ok && old.data.cabinet).toEqual({ accountId: null, open: false });
  });
});

describe("формы кабинета", () => {
  it("ссылка: название от двух знаков, заметка до 120; источник по умолчанию — канал", () => {
    expect(emptyLinkForm()).toEqual({ campaign: "", source: "channel", note: "" });
    expect(linkFormProblems(emptyLinkForm()).campaign).toMatch(/от 2 до 80/);
    expect(linkFormProblems({ campaign: "я", source: "post", note: "" }).campaign).toBeDefined();
    expect(linkFormProblems({ campaign: "Мой канал", source: "post", note: "" })).toEqual({});
    expect(linkFormProblems({ campaign: "Мой канал", source: "post", note: "я".repeat(CABINET_LIMITS.noteMax + 1) }).note).toMatch(/120/);
    expect(linkFormProblems({ campaign: "Мой канал", source: "post", note: "я".repeat(CABINET_LIMITS.noteMax) })).toEqual({});
  });

  it("источники — пять, у каждого русская подпись", () => {
    expect(LINK_SOURCES).toEqual(["channel", "post", "stream", "chat", "other"]);
    expect(LINK_SOURCES.map((source) => SOURCE_TITLES[source])).toEqual(["Канал", "Пост", "Стрим", "Чат", "Другое"]);
  });

  it("слово копии: от четырёх знаков, до сорока восьми", () => {
    expect(codeProblem("abc")).toMatch(/Не короче 4/);
    expect(codeProblem("   abc  ")).toMatch(/Не короче 4/);
    expect(codeProblem("abcd")).toBeNull();
    expect(codeProblem("я".repeat(49))).toMatch(/Не длиннее 48/);
  });

  it("копировать нельзя пачку, кончившийся код и при выбранном лимите; иначе можно", () => {
    const room = { used: 1, max: 5 };
    expect(copyBlockedReason(PROMO, room)).toBeNull();
    expect(copyBlockedReason({ ...PROMO, kind: "batch" }, room)).toBe(CABINET_TEXTS.batchNote);
    expect(copyBlockedReason({ ...PROMO, state: "expired" }, room)).toMatch(/Срок кода вышел/);
    expect(copyBlockedReason(PROMO, { used: 5, max: 5 })).toBe(CABINET_TEXTS.ceiling);
  });

  it("погашено из лимита и плашка просмотра", () => {
    expect(redeemedText(PROMO)).toBe("12 из 300");
    expect(redeemedText({ redeemed: 7, maxRedemptions: null })).toBe("7");
    expect(viewBanner("Игровой угол")).toBe("Просмотр кабинета партнёра «Игровой угол»");
    expect(CABINET_TEXTS.ceiling).toBe("Это потолок кабинета — напишите команде, если нужно больше");
    expect(CABINET_TEXTS.noLinks).toBe("Ссылок пока нет — заведите первую для своего канала");
  });
});

describe("раздел «Кабинет»", () => {
  it("есть в меню с правом partner.cabinet и своим экраном; без права не виден", () => {
    const section = SECTIONS.find((candidate) => candidate.id === "cabinet");
    expect(section?.permission).toBe("partner.cabinet");
    expect(locateSection("cabinet")?.section.title).toBe("Кабинет");
    expect(SECTION_SCREENS["cabinet"]).toBeTypeOf("function");
    expect(visibleGroups(["players.view"]).flatMap((group) => group.sections).some((candidate) => candidate.id === "cabinet")).toBe(false);
  });

  it("партнёр, у которого из прав только partner.cabinet, открывается сразу на кабинете, а чужие адреса его туда же возвращают", () => {
    expect(resolveRoute(null, ["partner.cabinet"])).toEqual({ section: "cabinet", id: null });
    expect(resolveRoute({ section: "partners", id: null }, ["partner.cabinet"])).toEqual({ section: "cabinet", id: null });
    expect(resolveRoute({ section: "players", id: "x" }, ["partner.cabinet"])).toEqual({ section: "cabinet", id: null });
  });

  it("команда с множеством прав кабинетом не начинается: он последний в меню", () => {
    const route = resolveRoute(null, ["partner.cabinet", "players.view"]);
    expect(route?.section).toBe("players");
  });
});

function partner() {
  return {
    partnerId: "p-1",
    name: "Канал",
    contact: null,
    note: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    telegramId: "900300",
    status: "active",
    country: null,
    payoutCurrency: null,
    payoutMethod: null,
    sharePercent: null,
    stats: { codes: 0, activeCodes: 0, redeemed: 0, bound: 0, played: 0, payers: 0, stars: 0 },
  };
}
