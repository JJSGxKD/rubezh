import { describe, expect, it } from "vitest";
import ru from "../src/i18n/ru-emblems.json";
import ruTasks from "../src/i18n/ru-tasks.json";
import { EMBLEM_FIT_MIN_WIDTH, GROUP_ORDER, emblemFit, emblemLabel, emblemTone, groupEmblems, heldCount } from "../src/screens/meta/emblem-rules";

// Правила знаков у имени (tasks/T-0236, docs/35-stage4-plan.md Р149): порядок
// групп, название сезонного знака, порог «значок или значок с названием» и тон
// редкости — чистые функции, без React.

const item = (id: string, category: string, held: boolean) => ({ id, category, held });

describe("группы знаков", () => {
  it("порядок групп — статус, сезоны, заслуги", () => {
    expect(GROUP_ORDER).toEqual(["status", "season", "merit"]);
  });

  it("группы идут по порядку, внутри держимые раньше закрытых, а порядок сервера сохраняется", () => {
    const groups = groupEmblems([
      item("m1", "merit", false),
      item("m2", "merit", true),
      item("s1", "season", false),
      item("t1", "status", false),
      item("t2", "status", true),
      item("m3", "merit", true),
      item("t3", "status", true),
    ]);

    expect(groups.map((group) => group.category)).toEqual(["status", "season", "merit"]);
    expect(groups[0]?.items.map((entry) => entry.id)).toEqual(["t2", "t3", "t1"]);
    expect(groups[1]?.items.map((entry) => entry.id)).toEqual(["s1"]);
    expect(groups[2]?.items.map((entry) => entry.id)).toEqual(["m2", "m3", "m1"]);
  });

  it("пустая группа опускается", () => {
    const groups = groupEmblems([item("m1", "merit", true), item("t1", "status", false)]);

    expect(groups.map((group) => group.category)).toEqual(["status", "merit"]);
    expect(groupEmblems([])).toEqual([]);
  });

  it("категория, которой клиент не знает (сервер новее), идёт в заслуги, а не пропадает", () => {
    const groups = groupEmblems([item("x1", "legacy", true), item("m1", "merit", false)]);

    expect(groups.map((group) => group.category)).toEqual(["merit"]);
    expect(groups[0]?.items.map((entry) => entry.id)).toEqual(["x1", "m1"]);
  });
});

describe("название знака", () => {
  it("у сезонного — с номером сезона", () => {
    expect(emblemLabel({ title: "Чемпион", season: 3 })).toBe("Чемпион · сезон 3");
  });

  it("у остальных — как отдал сервер", () => {
    expect(emblemLabel({ title: "Тестер" })).toBe("Тестер");
    expect(emblemLabel({ title: "Скрытый знак", season: undefined })).toBe("Скрытый знак");
  });
});

describe("значок или значок с названием", () => {
  it("уже 360 px — только значок, от 360 — значок с названием", () => {
    expect(EMBLEM_FIT_MIN_WIDTH).toBe(360);
    expect(emblemFit(359)).toBe("glyph");
    expect(emblemFit(360)).toBe("full");
    expect(emblemFit(320)).toBe("glyph");
    expect(emblemFit(390)).toBe("full");
    expect(emblemFit(1440)).toBe("full");
  });
});

describe("сколько знаков держит игрок", () => {
  it("считаются только держимые", () => {
    expect(heldCount([item("a", "status", true), item("b", "merit", false), item("c", "merit", true)])).toBe(2);
    expect(heldCount([])).toBe(0);
  });
});

describe("тон знака", () => {
  it("у `team` — бирюза оберегов, у `partner` — акцент, у остальных тон редкости предмета", () => {
    expect(emblemTone("team")).toBe("var(--color-secondary)");
    expect(emblemTone("partner")).toBe("var(--color-accent)");
    expect(emblemTone("rare")).toBe("var(--color-info)");
    expect(emblemTone("epic")).toBe("var(--color-passive)");
    expect(emblemTone("legendary")).toBe("var(--color-elite)");
    expect(emblemTone("mythic")).toBe("var(--color-danger)");
  });

  it("незнакомая редкость от сервера новее клиента — как обычная", () => {
    expect(emblemTone("cosmic")).toBe(emblemTone("common"));
  });
});

describe("тексты знаков", () => {
  it("тексты из спецификации; обращение — на «ты»", () => {
    expect(ru["emblems.open"]).toBe("Знаки · {count}");
    expect(ru["emblems.title"]).toBe("Знаки");
    expect(ru["emblems.group.status"]).toBe("Статус");
    expect(ru["emblems.group.season"]).toBe("Сезоны");
    expect(ru["emblems.group.merit"]).toBe("Заслуги");
    expect(ru["emblems.season"]).toBe("{title} · сезон {season}");
    expect(ru["emblems.rarity"]).toBe("Есть у {percent}% игроков");
    expect(ru["emblems.wear"]).toBe("Носить у имени");
    expect(ru["emblems.current"]).toBe("Сейчас у имени");
    expect(ru["emblems.auto"]).toBe("По умолчанию");
    expect(ru["emblems.autoNow"]).toBe("По умолчанию — сейчас «{title}»");
    expect(ru["emblems.autoNone"]).toBe("По умолчанию — без знака");
    expect(ru["emblems.loading"]).toBe("Загружаем знаки…");
  });

  it("категории витрины достижений — «Статус» и «Сезоны»", () => {
    expect(ruTasks["achievements.category.status"]).toBe("Статус");
    expect(ruTasks["achievements.category.season"]).toBe("Сезоны");
  });
});
