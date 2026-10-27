import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { cspSummarySchema, directiveGroup, fetchCspSummary, hostTitle, sortEntries, type CspEntry } from "../src/api/csp-reports";
import { SECTION_GROUPS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

const ENTRY: CspEntry = { directive: "script-src", host: "fonts.gstatic.com", count: 3, lastAt: "2026-10-20T10:00:00.000Z" };

describe("блокировки клиента: запрос", () => {
  it("сводка читается с сервера и разбирается схемой", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { entries: [ENTRY], overflow: 0, maxEntries: 200 } }));
    const result = await fetchCspSummary(new AdminApi(fetch));
    expect(calls[0]?.url).toBe("/api/v1/admin/csp-reports");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.entries).toEqual([ENTRY]);
  });

  it("запись с лишним полем не ломает разбор", () => {
    const parsed = cspSummarySchema.parse({ entries: [{ ...ENTRY, pageUrl: "https://example.org/x" }], overflow: 0, maxEntries: 200 });
    expect(parsed.entries[0]).not.toHaveProperty("pageUrl");
  });

  it("ответ без entries отвергается схемой", async () => {
    const { fetch } = fakeFetch(json(200, { data: { overflow: 0, maxEntries: 200 } }));
    const result = await fetchCspSummary(new AdminApi(fetch));
    expect(result.ok).toBe(false);
  });
});

describe("блокировки клиента: подписи", () => {
  it("директива сводится к человеческой группе", () => {
    expect(directiveGroup("script-src-elem")).toBe("скрипты");
    expect(directiveGroup("font-src")).toBe("шрифты");
    expect(directiveGroup("other")).toBe("другое");
  });

  it("незнакомая директива показывается как есть", () => {
    expect(directiveGroup("trusted-types")).toBe("trusted-types");
  });

  it("служебные значения хоста — по-русски, настоящий хост без изменений", () => {
    expect(hostTitle("inline")).toBe("встроенный код");
    expect(hostTitle("other")).toBe("другое");
    expect(hostTitle("fonts.gstatic.com")).toBe("fonts.gstatic.com");
  });
});

describe("блокировки клиента: порядок", () => {
  const older: CspEntry = { directive: "img-src", host: "a.example", count: 9, lastAt: "2026-10-19T10:00:00.000Z" };
  const fresher: CspEntry = { directive: "img-src", host: "b.example", count: 1, lastAt: "2026-10-21T10:00:00.000Z" };
  const tie: CspEntry = { directive: "img-src", host: "c.example", count: 9, lastAt: "2026-10-22T10:00:00.000Z" };

  it("«свежие» — по времени последнего блокирования, новее выше", () => {
    expect(sortEntries([older, fresher, tie], "fresh").map((entry) => entry.host)).toEqual(["c.example", "b.example", "a.example"]);
  });

  it("«частые» — по числу; при равенстве выше свежая", () => {
    expect(sortEntries([older, fresher, tie], "count").map((entry) => entry.host)).toEqual(["c.example", "a.example", "b.example"]);
  });

  it("исходный массив не меняется", () => {
    const source = [older, fresher];
    sortEntries(source, "count");
    expect(source).toEqual([older, fresher]);
  });
});

describe("блокировки клиента: меню", () => {
  it("раздел в группе «Эксплуатация», за правом диагностики, подсказка короткая", () => {
    const group = SECTION_GROUPS.find((item) => item.title === "Эксплуатация");
    const section = group?.sections.find((item) => item.id === "csp");
    expect(section?.permission).toBe("diagnostics.view");
    expect(section?.hint.length).toBeLessThanOrEqual(80);
  });
});
