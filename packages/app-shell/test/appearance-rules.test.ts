import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APPEARANCE_ORDER,
  appearanceNameKey,
  cardState,
  gridColumns,
  showHead,
  sortAppearances,
  sourceText,
} from "../src/screens/meta/appearance-rules";
import { appearanceCardUrl, appearanceHeadUrl, appearancePortraitUrl } from "../src/screens/meta/appearance-art";
import ru from "../src/i18n/ru-appearance.json";

// Правила экрана «Облик» (tasks/T-0238, docs/35-stage4-plan.md Р150): текст
// источника, кто видит голову, колонки сетки, порядок карточек и ассеты.

describe("текст источника облика", () => {
  it("«с самого начала»", () => {
    expect(sourceText({ kind: "start" })).toEqual({ key: "appearance.source.start", params: {} });
  });

  it("уровень аккаунта — с числом", () => {
    expect(sourceText({ kind: "level", level: 20 })).toEqual({ key: "appearance.source.level", params: { level: 20 } });
  });

  it("верхняя ступень очков недели", () => {
    expect(sourceText({ kind: "weekly_points" })).toEqual({ key: "appearance.source.weeklyPoints", params: {} });
  });

  it("достижение — с названием из ответа сервера", () => {
    expect(sourceText({ kind: "achievement", achievementId: "ach_elite_50", title: "Гроза элит" })).toEqual({
      key: "appearance.source.achievement",
      params: { title: "Гроза элит" },
    });
  });

  it("достижение без названия — по id, а не пустые кавычки", () => {
    expect(sourceText({ kind: "achievement", achievementId: "ach_elite_50" })?.params).toEqual({ title: "ach_elite_50" });
  });

  it("Ярмарка, VIP", () => {
    expect(sourceText({ kind: "event" })?.key).toBe("appearance.source.event");
    expect(sourceText({ kind: "vip" })?.key).toBe("appearance.source.vip");
  });

  it("сезон — топ-N по `maxPlace`", () => {
    expect(sourceText({ kind: "season", maxPlace: 3 })).toEqual({ key: "appearance.source.season", params: { place: 3 } });
  });

  it("источник, которого клиент не знает, или без числа — без строки, а не ключ на экране", () => {
    expect(sourceText({ kind: "lottery" })).toBeNull();
    expect(sourceText({ kind: "level" })).toBeNull();
    expect(sourceText({ kind: "season" })).toBeNull();
  });

  it("каждый ключ источника есть в словаре и подставляет параметры", () => {
    const dictionary: Record<string, string> = ru;
    for (const source of [
      { kind: "start" },
      { kind: "level", level: 5 },
      { kind: "weekly_points" },
      { kind: "achievement", achievementId: "a", title: "Гроза элит" },
      { kind: "event" },
      { kind: "vip" },
      { kind: "season", maxPlace: 3 },
    ]) {
      const text = sourceText(source);
      expect(text, source.kind).not.toBeNull();
      expect(dictionary[text?.key ?? ""], source.kind).toBeTypeOf("string");
    }
    expect(dictionary["appearance.source.level"]).toContain("{level}");
    expect(dictionary["appearance.source.achievement"]).toContain("{title}");
    expect(dictionary["appearance.source.season"]).toContain("{place}");
  });
});

describe("голова облика в кружке", () => {
  it("зритель без арта голову не видит, что бы ни было в строке", () => {
    expect(showHead(false, "vityaz", false)).toBe(false);
    expect(showHead(false, "keeper", undefined)).toBe(false);
  });

  it("с артом, но игрок выбрал фото — фото", () => {
    expect(showHead(true, "vityaz", true)).toBe(false);
  });

  it("с артом и обликом — голова; `avatarPhoto: false` и «нет поля» — тоже голова", () => {
    expect(showHead(true, "vityaz", false)).toBe(true);
    expect(showHead(true, "vityaz", undefined)).toBe(true);
  });

  it("без облика в строке (сервер до обликов) — фото, как сейчас", () => {
    expect(showHead(true, undefined, undefined)).toBe(false);
    expect(showHead(true, undefined, false)).toBe(false);
  });
});

describe("сетка карточек", () => {
  it("по две до 400 px, по три шире", () => {
    expect(gridColumns(320)).toBe(2);
    expect(gridColumns(390)).toBe(2);
    expect(gridColumns(399)).toBe(2);
    expect(gridColumns(400)).toBe(3);
    expect(gridColumns(768)).toBe(3);
    expect(gridColumns(1440)).toBe(3);
  });
});

describe("порядок карточек", () => {
  it("по порядку каталога сервера, даже если ответ пришёл вразнобой", () => {
    const shuffled = ["navi", "keeper", "vedunya", "frost", "knyaz", "gilded", "vityaz", "herbalist", "skomoroh", "ohotnitsa"].map((id) => ({ id }));

    expect(sortAppearances(shuffled).map((item) => item.id)).toEqual([...APPEARANCE_ORDER]);
  });

  it("облик, которого клиент не знает, идёт в конце, остальное — на местах", () => {
    const items = [{ id: "future" }, { id: "vityaz" }, { id: "keeper" }, { id: "later" }];

    expect(sortAppearances(items).map((item) => item.id)).toEqual(["keeper", "vityaz", "future", "later"]);
  });

  it("не меняет входной массив", () => {
    const items = [{ id: "vityaz" }, { id: "keeper" }];
    sortAppearances(items);

    expect(items.map((item) => item.id)).toEqual(["vityaz", "keeper"]);
  });
});

describe("состояние карточки", () => {
  it("выбранный и полученный — «надет»; полученный другой — «можно надеть»; закрытый — «закрыт»", () => {
    expect(cardState({ id: "vityaz", held: true }, "vityaz")).toBe("worn");
    expect(cardState({ id: "frost", held: true }, "vityaz")).toBe("owned");
    expect(cardState({ id: "knyaz", held: false }, "vityaz")).toBe("locked");
  });

  it("закрытый не бывает «надетым», даже если он назван действующим", () => {
    expect(cardState({ id: "knyaz", held: false }, "knyaz")).toBe("locked");
  });
});

describe("названия и ассеты десяти обликов", () => {
  it("у каждого облика есть имя в словаре; незнакомому имени ключа нет", () => {
    const dictionary: Record<string, string> = ru;
    for (const id of APPEARANCE_ORDER) expect(dictionary[appearanceNameKey(id) ?? ""], id).toBeTypeOf("string");
    expect(appearanceNameKey("future")).toBeNull();
  });

  it("портрет, голова и карточка есть на диске для каждого облика", () => {
    for (const id of APPEARANCE_ORDER) {
      for (const url of [appearancePortraitUrl(id), appearanceHeadUrl(id), appearanceCardUrl(id)]) {
        expect(existsSync(fileURLToPath(url)), `${id}: ${url}`).toBe(true);
      }
    }
  });

  it("неизвестный id — Хранитель", () => {
    expect(appearanceHeadUrl("future")).toBe(appearanceHeadUrl("keeper"));
    expect(appearancePortraitUrl("future")).toBe(appearancePortraitUrl("keeper"));
    expect(appearanceCardUrl("future")).toBe(appearanceCardUrl("keeper"));
  });

  it("разные облики — разные рисунки", () => {
    expect(appearanceHeadUrl("vityaz")).not.toBe(appearanceHeadUrl("keeper"));
    expect(appearancePortraitUrl("navi")).not.toBe(appearancePortraitUrl("knyaz"));
  });
});
