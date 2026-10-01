import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchSettings, groupSettings, resetSetting, saveSetting, settingProblem, settingText, type SettingRow } from "../src/api/settings";
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
    expect(settingProblem("chat", "-1001234567890:57")).toBeNull();
    expect(settingProblem("chat", "")).toBeNull();
    // ссылка — только https; пусто — «не задана»
    expect(settingProblem("url", "https://t.me/tribute/app?startapp=stars")).toBeNull();
    expect(settingProblem("url", "")).toBeNull();
    expect(settingProblem("url", "http://t.me/tribute")).toMatch(/https/);
    expect(settingProblem("url", "t.me/tribute")).toMatch(/https/);
    expect(settingProblem("chat", "@team")).not.toBeNull();
    expect(settingProblem("chat", "-100:")).not.toBeNull();
    expect(settingProblem("boolean", true)).toBeNull();
  });

  it("значение для человека и разделы в порядке каталога", () => {
    expect(settingText("chat", "")).toBe("не задан");
    expect(settingText("boolean", false)).toBe("выключено");
    expect(settingText("chat", null)).toBe("—");
    expect(groupSettings([CHAT, REPORTS, { ...CHAT, key: "x", group: "Другое" }]).map((item) => [item.group, item.rows.length])).toEqual([
      ["Уведомления команде", 2],
      ["Другое", 1],
    ]);
    expect(SECTIONS.find((section) => section.id === "settings")?.permission).toBe("settings.edit");
  });
});
