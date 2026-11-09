import { describe, expect, it } from "vitest";
import {
  CATEGORY_ORDER,
  cards,
  currentRung,
  groupByCategory,
  nextFavorites,
  openedCount,
  percentText,
  rarityTier,
} from "../src/screens/meta/achievements-rules";
import type { AchievementItem, OpenAchievement } from "../src/state/achievements-api";

// Правила витрины достижений (tasks/T-0107): категории в своём порядке, лестница
// одной карточкой с текущей ступенью, редкость по границам 40 / 15 / 5, любимые
// не больше трёх и только открытые.

function open(id: string, patch: Partial<OpenAchievement> = {}): OpenAchievement {
  return {
    id,
    category: "combat",
    ladder: null,
    rung: null,
    hidden: false,
    kind: "kills",
    title: id,
    target: 100,
    value: 0,
    done: false,
    claimed: false,
    reward: { coins: 50, gems: 0, shards: 0 },
    prestige: 5,
    percent: null,
    ...patch,
  };
}

function closed(id: string, category: AchievementItem["category"] = "mastery"): AchievementItem {
  return { id, category, hidden: true, done: false, hint: "Подсказка" };
}

function rung(rungNo: number, patch: Partial<OpenAchievement> = {}): OpenAchievement {
  return open(`kills_${String(rungNo)}`, { ladder: "kills", rung: rungNo, target: rungNo * 100, ...patch });
}

describe("groupByCategory", () => {
  it("порядок категорий: бой, коллекция, мастерство, друзья; порядок внутри — как отдал сервер", () => {
    const items = [
      open("m1", { category: "mastery" }),
      open("f1", { category: "friends" }),
      open("c1", { category: "collection" }),
      open("b1", { category: "combat" }),
      open("b2", { category: "combat" }),
      open("m2", { category: "mastery" }),
    ];

    const groups = groupByCategory(items);

    expect(CATEGORY_ORDER).toEqual(["combat", "collection", "mastery", "friends"]);
    expect(groups.map((group) => group.category)).toEqual(["combat", "collection", "mastery", "friends"]);
    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([["b1", "b2"], ["c1"], ["m1", "m2"], ["f1"]]);
  });

  it("пустая категория опущена; пустой список — пустая витрина", () => {
    const groups = groupByCategory([open("b1"), open("f1", { category: "friends" })]);

    expect(groups.map((group) => group.category)).toEqual(["combat", "friends"]);
    expect(groupByCategory([])).toEqual([]);
  });

  it("категория, которой клиент не знает, не пропадает: идёт после известных", () => {
    const future = { ...open("x1"), category: "seasons" } as unknown as AchievementItem;

    const groups = groupByCategory([future, open("b1")]);

    expect(groups.map((group) => group.category)).toEqual(["combat", "seasons"]);
  });
});

describe("cards", () => {
  it("три строки лестницы склеены в одну карточку, одиночная и скрытая — отдельные, порядок по первой строке", () => {
    const single = open("first_run");
    const hidden = closed("secret_one", "combat");
    const items: AchievementItem[] = [rung(2), single, rung(1), hidden, rung(3)];

    const result = cards(items);

    expect(result.map((card) => card.kind)).toEqual(["ladder", "single", "single"]);
    const ladder = result[0];
    expect(ladder?.kind === "ladder" && ladder.rungs.map((item) => item.id)).toEqual(["kills_1", "kills_2", "kills_3"]);
    expect(result[1]).toMatchObject({ kind: "single", item: { id: "first_run" } });
    expect(result[2]).toMatchObject({ kind: "single", item: { id: "secret_one" } });
  });

  it("у карточки-лестницы текущая ступень выбрана по правилу", () => {
    const [card] = cards([rung(1, { done: true, claimed: true, value: 100 }), rung(2, { value: 40 }), rung(3)]);

    expect(card?.kind === "ladder" && card.current.id).toBe("kills_2");
  });

  it("лестница из одной строки остаётся лестницей, а строка без лестницы — одиночной", () => {
    const result = cards([rung(1), open("lonely")]);

    expect(result.map((card) => card.kind)).toEqual(["ladder", "single"]);
  });
});

describe("currentRung", () => {
  it("готова к забору вторая ступень — вторая", () => {
    const rungs = [rung(1, { done: true, claimed: true }), rung(2, { done: true }), rung(3)];
    expect(currentRung(rungs).id).toBe("kills_2");
  });

  it("готова к забору первая, а вторая тоже выполнена — первая: что можно забрать, идёт первым", () => {
    const rungs = [rung(1, { done: true }), rung(2, { done: true }), rung(3)];
    expect(currentRung(rungs).id).toBe("kills_1");
  });

  it("ни одна не готова, первая выполнена и забрана — вторая", () => {
    const rungs = [rung(1, { done: true, claimed: true }), rung(2, { value: 10 }), rung(3)];
    expect(currentRung(rungs).id).toBe("kills_2");
  });

  it("все выполнены и забраны — последняя", () => {
    const rungs = [rung(1, { done: true, claimed: true }), rung(2, { done: true, claimed: true }), rung(3, { done: true, claimed: true })];
    expect(currentRung(rungs).id).toBe("kills_3");
  });

  it("одна ступень — она; ничего не начато — первая", () => {
    expect(currentRung([rung(1)]).id).toBe("kills_1");
    expect(currentRung([rung(1), rung(2)]).id).toBe("kills_1");
  });
});

describe("rarityTier", () => {
  it("границы 40 / 15 / 5 включительно снизу", () => {
    expect(rarityTier(100)).toBe("common");
    expect(rarityTier(40)).toBe("common");
    expect(rarityTier(39.9)).toBe("uncommon");
    expect(rarityTier(15)).toBe("uncommon");
    expect(rarityTier(14.9)).toBe("rare");
    expect(rarityTier(5)).toBe("rare");
    expect(rarityTier(4.9)).toBe("epic");
    expect(rarityTier(0)).toBe("epic");
  });

  it("процента нет — ступени нет", () => {
    expect(rarityTier(null)).toBeNull();
  });
});

describe("percentText", () => {
  it("запятая, один знак после неё, без хвостового нуля", () => {
    expect(percentText(12.3)).toBe("12,3");
    expect(percentText(100)).toBe("100");
    expect(percentText(0.5)).toBe("0,5");
    expect(percentText(7)).toBe("7");
    expect(percentText(7.04)).toBe("7");
  });
});

describe("nextFavorites", () => {
  it("добавить открытое к двум — три, порядок слотов сохранён", () => {
    expect(nextFavorites(["a", "b"], "c", true)).toEqual({ ok: true, ids: ["a", "b", "c"] });
  });

  it("добавить четвёртое — отказ «любимых уже три»", () => {
    expect(nextFavorites(["a", "b", "c"], "d", true)).toEqual({ ok: false, reason: "full" });
  });

  it("добавить закрытое — отказ «только открытое»; заполненные слоты ему не важны", () => {
    expect(nextFavorites(["a"], "z", false)).toEqual({ ok: false, reason: "locked" });
    expect(nextFavorites(["a", "b", "c"], "z", false)).toEqual({ ok: false, reason: "locked" });
  });

  it("снять — всегда можно, порядок прочих сохранён, даже если достижение уже закрыто", () => {
    expect(nextFavorites(["a", "b", "c"], "b", true)).toEqual({ ok: true, ids: ["a", "c"] });
    expect(nextFavorites(["a", "b", "c"], "b", false)).toEqual({ ok: true, ids: ["a", "c"] });
  });

  it("повторное добавление не дублирует: уже любимое снимается, а не встаёт дважды", () => {
    const result = nextFavorites(["a", "b"], "a", true);

    expect(result).toEqual({ ok: true, ids: ["b"] });
    expect(nextFavorites(["a"], "a", true)).toEqual({ ok: true, ids: [] });
  });

  it("исходный список не меняется", () => {
    const current = ["a", "b"];
    nextFavorites(current, "c", true);
    nextFavorites(current, "a", true);
    expect(current).toEqual(["a", "b"]);
  });
});

describe("openedCount", () => {
  it("считает выполненные; закрытые скрытые выполненными не считаются", () => {
    const items: AchievementItem[] = [open("a", { done: true }), open("b"), closed("c"), open("d", { done: true, claimed: true, hidden: true })];

    expect(openedCount(items)).toBe(2);
    expect(openedCount([])).toBe(0);
  });
});
