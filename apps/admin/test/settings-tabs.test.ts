import { describe, expect, it } from "vitest";
import type { SettingRow } from "../src/api/settings";
import { hrefOf, parseRoute } from "../src/routes";
import { SETTING_GROUP_SLUGS, settingsTabOf, settingsTabs } from "../src/screens/settings/settings-tabs";

const BASE: SettingRow = {
  key: "notify.chat.general",
  group: "Уведомления команде",
  title: "Общий чат",
  hint: "Подсказка",
  kind: "chat",
  value: "-200:4",
  source: "base",
  envValue: "-100",
  fallback: "",
  updatedBy: null,
  updatedAt: null,
};
const row = (key: string, group: string): SettingRow => ({ ...BASE, key, group });

const SHOP_1 = row("shop.a", "Магазин");
const ADS_1 = row("ads.test-mode", "Реклама");
const SHOP_2 = row("shop.b", "Магазин");

describe("вкладки настроек", () => {
  it("латинские имена уникальны и без точки: не путаются с ключом настройки", () => {
    const slugs = Object.values(SETTING_GROUP_SLUGS);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("группы — вкладки в порядке появления, строки собраны по группе", () => {
    const tabs = settingsTabs([SHOP_1, ADS_1, SHOP_2]);
    expect(tabs.map((tab) => tab.id)).toEqual(["shop", "ads"]);
    expect(tabs[0]?.rows).toEqual([SHOP_1, SHOP_2]);
    expect(tabs[1]?.rows).toEqual([ADS_1]);
    expect(tabs[0]?.title).toBe("Магазин");
  });

  it("группа вне таблицы получает вкладку с названием в адресе", () => {
    const tabs = settingsTabs([row("new.key", "Новая группа")]);
    const tab = tabs[0];
    expect(tab?.id).toBe("Новая группа");
    const href = hrefOf({ section: "settings", id: tab?.id ?? null });
    expect(href).toContain("#/settings/%D0%9D");
    expect(parseRoute(href)?.id).toBe("Новая группа");
  });

  describe("settingsTabOf", () => {
    const tabs = settingsTabs([SHOP_1, ADS_1]);
    it("нет хвоста — первая вкладка", () => {
      expect(settingsTabOf(null, tabs)).toEqual({ tab: tabs[0], focus: null });
    });
    it("имя группы из таблицы", () => {
      expect(settingsTabOf("ads", tabs)).toEqual({ tab: tabs[1], focus: null });
    });
    it("название группы", () => {
      expect(settingsTabOf("Реклама", tabs).tab).toBe(tabs[1]);
    });
    it("ключ настройки — вкладка группы и подсветка строки", () => {
      expect(settingsTabOf("ads.test-mode", tabs)).toEqual({ tab: tabs[1], focus: "ads.test-mode" });
    });
    it("неизвестное — первая вкладка без подсветки", () => {
      expect(settingsTabOf("ads.unknown", tabs)).toEqual({ tab: tabs[0], focus: null });
    });
    it("вкладок нет", () => {
      expect(settingsTabOf("ads", [])).toEqual({ tab: null, focus: null });
    });
  });
});
