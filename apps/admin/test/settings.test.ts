import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchSettings, groupSettings, parseInteger, resetSetting, saveSetting, settingProblem, settingText, type SettingRow } from "../src/api/settings";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

const CHAT: SettingRow = {
  key: "notify.chat.general",
  group: "Уведомления команде",
  title: "Общий чат администраторов",
  hint: "Меню команд администратора",
  kind: "chat",
  value: "-200:4",
  source: "base",
  envValue: "-100",
  fallback: "",
  updatedBy: "00000000-0000-4000-8000-000000000001",
  updatedAt: "2026-09-29T01:00:00.000Z",
};
const REPORTS: SettingRow = { ...CHAT, key: "notify.reports", title: "Карточки отчётов", kind: "boolean", value: true, source: "default", envValue: null, fallback: true, updatedBy: null, updatedAt: null };

describe("настройки в панели", () => {
  it("список, запись без пробелов по краям и сброс по ключу", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { settings: [CHAT, REPORTS] } }), json(200, { data: CHAT }), json(200, { data: { ...CHAT, value: "-100", source: "env" } }));
    const api = new AdminApi(fetch);

    const list = await fetchSettings(api);
    expect(list.ok && list.data.settings.map((row) => row.source)).toEqual(["base", "default"]);

    await saveSetting(api, "notify.chat.general", "  -200:4 ");
    expect(calls[1]?.url).toBe("/api/v1/admin/settings/notify.chat.general");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ value: "-200:4" });

    const reset = await resetSetting(api, "notify.chat.general");
    expect(reset.ok && reset.data.source).toBe("env");
    expect(calls[2]?.url).toBe("/api/v1/admin/settings/notify.chat.general/reset");
  });

  it("форма проверяет адрес чата так же, как сервер", () => {
    expect(settingProblem({ kind: "chat" }, "-1001234567890:57")).toBeNull();
    expect(settingProblem({ kind: "chat" }, "")).toBeNull();
    // ссылка — только https; пусто — «не задана»
    expect(settingProblem({ kind: "url" }, "https://t.me/tribute/app?startapp=stars")).toBeNull();
    expect(settingProblem({ kind: "url" }, "")).toBeNull();
    expect(settingProblem({ kind: "url" }, "http://t.me/tribute")).toMatch(/https/);
    expect(settingProblem({ kind: "url" }, "t.me/tribute")).toMatch(/https/);
    expect(settingProblem({ kind: "chat" }, "@team")).not.toBeNull();
    expect(settingProblem({ kind: "chat" }, "-100:")).not.toBeNull();
    expect(settingProblem({ kind: "boolean" }, true)).toBeNull();
  });

  it("число — целое в пределах, с единицей словами; пустое поле — не ноль", () => {
    const every = { kind: "number" as const, range: { min: 1, max: 20, unit: ["забег", "забега", "забегов"] as [string, string, string] } };
    expect(settingProblem(every, "3")).toBeNull();
    expect(settingProblem(every, 20)).toBeNull();
    expect(settingProblem(every, "0")).toBe("От 1 до 20");
    expect(settingProblem(every, "21")).toBe("От 1 до 20");
    expect(settingProblem(every, "")).toBe("Целое число");
    expect(settingProblem(every, "2.5")).toBe("Целое число");
    expect(settingProblem(every, "3 шт")).toBe("Целое число");
    expect(parseInteger(" 12 ")).toBe(12);
    expect(parseInteger("")).toBeNull();
    expect(settingText(every, 1)).toBe("1 забег");
    expect(settingText(every, 3)).toBe("3 забега");
    expect(settingText(every, 11)).toBe("11 забегов");
    // Сервер до числовых настроек пределов не отдавал — число без единицы.
    expect(settingText({ kind: "number" }, 7)).toBe("7");
  });

  it("значение для человека и разделы в порядке каталога", () => {
    expect(settingText({ kind: "chat" }, "")).toBe("не задан");
    expect(settingText({ kind: "boolean" }, false)).toBe("выключено");
    expect(settingText({ kind: "chat" }, null)).toBe("—");
    expect(groupSettings([CHAT, REPORTS, { ...CHAT, key: "x", group: "Другое" }]).map((item) => [item.group, item.rows.length])).toEqual([
      ["Уведомления команде", 2],
      ["Другое", 1],
    ]);
    expect(SECTIONS.find((section) => section.id === "settings")?.permission).toBe("settings.edit");
  });
});
