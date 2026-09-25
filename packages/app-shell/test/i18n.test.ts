import { describe, expect, it } from "vitest";
import { formatDuration, hasTranslation, t } from "../src/i18n";
// Ключ примера — из словаря забега: он подгружается с чанком экрана забега.
import "../src/i18n/run";
import { API_FAILURES } from "../src/state/api-request";

// Тексты интерфейса (docs/27-design-system-and-app-shell.md §8).

describe("переводы", () => {
  it("подставляет значения в шаблон", () => {
    expect(t("run.level", { level: 7 })).toBe("Уровень 7");
  });

  it("склоняет по-русски, а не конкатенацией", () => {
    // Три категории множественного числа: одна, две, пять.
    expect(t("lobby.runs", { count: 1 })).toBe("1 забег");
    expect(t("lobby.runs", { count: 3 })).toBe("3 забега");
    expect(t("lobby.runs", { count: 11 })).toBe("11 забегов");
    expect(t("lobby.runs", { count: 22 })).toBe("22 забега");
  });

  it("склоняет число участников в рейтинге", () => {
    expect(t("rating.me.of", { total: 1 })).toBe("из 1 участника");
    expect(t("rating.me.of", { total: 5 })).toBe("из 5 участников");
    expect(t("rating.pending", { count: 2 })).toContain("2 забега");
  });

  it("знает текст для каждой причины, по которой сервер не ответил", () => {
    for (const failure of API_FAILURES) {
      expect(hasTranslation(`sync.failure.${failure}`), failure).toBe(true);
    }
  });

  it("возвращает неизвестный ключ как есть — в интерфейсе он заметен", () => {
    expect(t("no.such.key")).toBe("no.such.key");
    expect(hasTranslation("no.such.key")).toBe(false);
  });

  it("не держит тексты инструментов команды в словаре первой загрузки", async () => {
    expect(hasTranslation("soundLab.title")).toBe(false);
    await import("../src/i18n/team");
    expect(t("soundLab.title")).toBe("Звуковая лаборатория");
    // Плашка читов на экране смерти видна и без чанка команды.
    expect(hasTranslation("dev.cheats.notCounted")).toBe(true);
  });

  it("знает ключи контента: имена оружия и пассивок приходят из core-game", () => {
    for (const key of ["weapon.spark.name", "passive.might.name", "upgrade.heal.name"]) {
      expect(hasTranslation(key), key).toBe(true);
    }
  });
});

describe("формат времени", () => {
  it("показывает минуты и секунды", () => {
    expect(formatDuration(185.4)).toBe("3:05");
    expect(formatDuration(0)).toBe("0:00");
  });

  it("не показывает игроку NaN из битого хранилища", () => {
    expect(formatDuration(Number.NaN)).toBe("0:00");
    expect(formatDuration(-5)).toBe("0:00");
  });
});
