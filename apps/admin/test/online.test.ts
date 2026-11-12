import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchOnline, hasCounted, onlineRows, onlineSnapshotSchema, type OnlineSnapshot } from "../src/api/online";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Раздел «Онлайн» (Р107, tasks/T-0148): ответ `GET /admin/online` разбирается
// схемой, строки площадок идут в порядке меню, а площадка, которой нет в
// ответе, остаётся нулями.

const SNAPSHOT: OnlineSnapshot = {
  byPlatform: {
    telegram: { app: 120, run: 30, today: 900 },
    max: { app: 5, run: 1, today: 40 },
    vk: { app: 3, run: 0, today: 20 },
    web: { app: 0, run: 0, today: 4 },
  },
  total: { app: 128, run: 31, today: 964 },
  peak: { value: 301, at: Date.parse("2026-10-25T18:00:00.000Z") },
  at: Date.parse("2026-11-09T12:00:00.000Z"),
};

describe("онлайн в панели: запрос", () => {
  it("снимок читается с сервера и разбирается схемой", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: SNAPSHOT }));
    const result = await fetchOnline(new AdminApi(fetch));
    expect(calls[0]?.url).toBe("/api/v1/admin/online");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(SNAPSHOT);
  });

  it("рекорда ещё нет — peak: null принимается", () => {
    expect(onlineSnapshotSchema.safeParse({ ...SNAPSHOT, peak: null }).success).toBe(true);
  });

  it("ответ без итога отвергается: таблица с undefined хуже честной ошибки", async () => {
    const { fetch } = fakeFetch(json(200, { data: { byPlatform: {}, peak: null, at: 0 } }));
    const result = await fetchOnline(new AdminApi(fetch));
    expect(result.ok).toBe(false);
  });
});

describe("онлайн в панели: строки", () => {
  it("площадки идут в порядке Telegram, MAX, VK, браузер, с русскими названиями", () => {
    expect(onlineRows(SNAPSHOT).map((row) => row.title)).toEqual(["Telegram", "MAX", "VK", "Браузер"]);
    expect(onlineRows(SNAPSHOT)[0]?.counts).toEqual({ app: 120, run: 30, today: 900 });
  });

  it("площадки нет в ответе — нули; незнакомая площадка новее панели строки не получает", () => {
    const rows = onlineRows({ ...SNAPSHOT, byPlatform: { telegram: SNAPSHOT.byPlatform["telegram"]!, ok: { app: 1, run: 1, today: 1 } } });
    expect(rows).toHaveLength(4);
    expect(rows[1]?.counts).toEqual({ app: 0, run: 0, today: 0 });
  });

  it("at: 0 — пересчёта не было, и нулевые числа не значат «никого нет»", () => {
    expect(hasCounted({ ...SNAPSHOT, at: 0 })).toBe(false);
    expect(hasCounted(SNAPSHOT)).toBe(true);
  });
});

describe("онлайн в панели: раздел", () => {
  it("раздел стоит в меню под правом аналитики игры, как и сервер его проверяет", () => {
    const section = SECTIONS.find((item) => item.id === "online");
    expect(section?.permission).toBe("analytics.gameplay.view");
  });
});
