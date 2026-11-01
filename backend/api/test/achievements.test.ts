import { describe, expect, it } from "vitest";
import { FAVORITES_MAX, favoritesSchema, itemOf, percentOf, rarityDue, summaryItemOf } from "../src/modules/achievements/achievement-rules.js";
import { ACHIEVEMENT_CATEGORIES, NO_ACHIEVEMENT_FIELDS, STATE_KINDS, TASK_KIND_IDS, isRunKind, isStateKind, taskDefSchema, type TaskDef } from "../src/modules/tasks/task-rules.js";

/**
 * Достижения с престижем (tasks/T-0106), чистые функции: процент «есть у N%»
 * с порогом населения, схема строки каталога с новыми полями, схема избранного,
 * срок пересчёта редкости и форма строки витрины — закрытое скрытое не
 * выдаёт ничего, кроме подсказки.
 */

/** Строка каталога так, как её присылает панель: достижение по убийствам. */
function row(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "ach_kills_1k",
    period: "achievement",
    kind: "kills",
    params: null,
    target: 1000,
    title: "Тысячник",
    coins: 200,
    gems: 0,
    shards: 0,
    passPoints: 0,
    sort: 0,
    active: true,
    tier: null,
    filter: null,
    limit: null,
    image: null,
    ...patch,
  };
}

function def(patch: Partial<TaskDef> = {}): TaskDef {
  return { ...taskDefSchema.parse(row()), ...patch };
}

const ACHIEVEMENT_FIELDS = { category: "combat", ladder: "kills", rung: 2, prestige: 10 } as const;

describe("percentOf: «есть у N%»", () => {
  it("население меньше порога — процента нет: у трёх игроков не будет «100%»", () => {
    expect(percentOf(3, 99, 100)).toBeNull();
    expect(percentOf(0, 99, 100)).toBeNull();
    expect(percentOf(1, 1, 2)).toBeNull();
  });

  it("население ровно на пороге — число", () => {
    expect(percentOf(50, 100, 100)).toBe(50);
    expect(percentOf(1, 100, 100)).toBe(1);
  });

  it("округление до десятой доли", () => {
    expect(percentOf(1, 3, 1)).toBe(33.3);
    expect(percentOf(2, 3, 1)).toBe(66.7);
    expect(percentOf(1, 8, 1)).toBe(12.5);
    expect(percentOf(1, 1000, 1)).toBe(0.1);
    expect(percentOf(1, 3000, 1)).toBe(0);
  });

  it("ни у кого — ноль, а не пустое место", () => {
    expect(percentOf(0, 500, 100)).toBe(0);
  });

  it("держателей больше населения (населения не хватало на момент пересчёта) — не выше 100", () => {
    expect(percentOf(7, 5, 1)).toBe(100);
    expect(percentOf(500, 500, 100)).toBe(100);
  });

  it("пустое население при любом пороге — процента нет, деления на ноль нет", () => {
    expect(percentOf(0, 0, 1)).toBeNull();
    expect(percentOf(0, 0, 100)).toBeNull();
  });
});

describe("rarityDue: когда пересчитывать редкость", () => {
  const NOW = new Date("2026-11-01T12:00:00Z");
  const MIN = 60_000;

  it("таблица пуста — пора", () => {
    expect(rarityDue(null, NOW, 360)).toBe(true);
  });

  it("свежий пересчёт — не пора, ровно через период — пора", () => {
    expect(rarityDue(new Date(NOW.getTime() - 359 * MIN), NOW, 360)).toBe(false);
    expect(rarityDue(new Date(NOW.getTime() - 360 * MIN), NOW, 360)).toBe(true);
    expect(rarityDue(new Date(NOW.getTime() - 361 * MIN), NOW, 360)).toBe(true);
  });

  it("часы, ушедшие назад, не запускают пересчёт на каждом тике", () => {
    expect(rarityDue(new Date(NOW.getTime() + 60 * MIN), NOW, 360)).toBe(false);
  });
});

describe("схема строки каталога: поля достижения", () => {
  it("строка без новых полей, как её слала прежняя панель, разбирается с пустыми значениями", () => {
    const parsed = taskDefSchema.parse(row());
    expect(parsed).toMatchObject({ category: null, ladder: null, rung: null, hidden: false, hint: null, prestige: 0 });
    expect(parsed).toMatchObject(NO_ACHIEVEMENT_FIELDS);
  });

  it("достижение с категорией, лестницей, ступенью и престижем принимается", () => {
    expect(taskDefSchema.safeParse(row(ACHIEVEMENT_FIELDS)).success).toBe(true);
  });

  it("подсказка без скрытого допустима, скрытое с подсказкой — тоже", () => {
    expect(taskDefSchema.safeParse(row({ ...ACHIEVEMENT_FIELDS, hint: "Подсказка" })).success).toBe(true);
    expect(taskDefSchema.safeParse(row({ ...ACHIEVEMENT_FIELDS, hidden: true, hint: "Подсказка" })).success).toBe(true);
  });

  it("скрытое без подсказки — отказ, и сообщение называет поле", () => {
    const result = taskDefSchema.safeParse(row({ ...ACHIEVEMENT_FIELDS, hidden: true }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("hint");
  });

  it("категория, лестница, ступень, подсказка, скрытое и престиж у ежедневного и недельного — отказ", () => {
    for (const period of ["daily", "weekly"]) {
      const base = { period, taskId: "daily_x" };
      expect(taskDefSchema.safeParse(row({ ...base, category: "combat" })).success, `${period}: category`).toBe(false);
      expect(taskDefSchema.safeParse(row({ ...base, ladder: "kills", rung: 1 })).success, `${period}: ladder`).toBe(false);
      expect(taskDefSchema.safeParse(row({ ...base, hint: "Подсказка" })).success, `${period}: hint`).toBe(false);
      expect(taskDefSchema.safeParse(row({ ...base, hidden: true, hint: "Подсказка" })).success, `${period}: hidden`).toBe(false);
      expect(taskDefSchema.safeParse(row({ ...base, prestige: 5 })).success, `${period}: prestige`).toBe(false);
    }
  });

  it("категория вне четырёх — отказ", () => {
    expect(taskDefSchema.safeParse(row({ ...ACHIEVEMENT_FIELDS, category: "pvp" })).success).toBe(false);
    for (const category of ACHIEVEMENT_CATEGORIES) expect(taskDefSchema.safeParse(row({ ...ACHIEVEMENT_FIELDS, category })).success, category).toBe(true);
  });

  it("ступень без лестницы и лестница без ступени — отказ; ступень не меньше единицы", () => {
    expect(taskDefSchema.safeParse(row({ category: "combat", rung: 1 })).success).toBe(false);
    expect(taskDefSchema.safeParse(row({ category: "combat", ladder: "kills" })).success).toBe(false);
    expect(taskDefSchema.safeParse(row({ category: "combat", ladder: "kills", rung: 0 })).success).toBe(false);
    expect(taskDefSchema.safeParse(row({ category: "combat", ladder: "Kills!", rung: 1 })).success).toBe(false);
  });

  it("престиж — целое неотрицательное в разумных пределах", () => {
    expect(taskDefSchema.safeParse(row({ ...ACHIEVEMENT_FIELDS, prestige: -1 })).success).toBe(false);
    expect(taskDefSchema.safeParse(row({ ...ACHIEVEMENT_FIELDS, prestige: 2.5 })).success).toBe(false);
    expect(taskDefSchema.safeParse(row({ ...ACHIEVEMENT_FIELDS, prestige: 1_000_000 })).success).toBe(false);
  });

  it("партнёрская цель достижением с категорией не бывает: её рисует вкладка партнёров", () => {
    const partner = { kind: "link", target: 1, params: { url: "https://example.com/p" } };
    expect(taskDefSchema.safeParse(row(partner)).success).toBe(true);
    expect(taskDefSchema.safeParse(row({ ...partner, category: "combat" })).success).toBe(false);
  });

  it("лишние поля по-прежнему отказ", () => {
    expect(taskDefSchema.safeParse(row({ ...ACHIEVEMENT_FIELDS, secret: 1 })).success).toBe(false);
  });
});

describe("виды «друзья» и «уровень аккаунта»", () => {
  it("забег их не двигает, поэтому они не вид забега, но вид каталога", () => {
    expect(STATE_KINDS.friends.op).toBe("max");
    expect(STATE_KINDS.account_level.op).toBe("max");
    for (const kind of ["friends", "account_level"] as const) {
      expect(isRunKind(kind), kind).toBe(false);
      expect(isStateKind(kind), kind).toBe(true);
      expect(TASK_KIND_IDS, kind).toContain(kind);
    }
    expect(isStateKind("kills")).toBe(false);
    expect(isStateKind("channel")).toBe(false);
  });

  it("вид «друзья» с фильтром — отказ; без фильтра у достижения — принимается", () => {
    expect(taskDefSchema.safeParse(row({ kind: "friends", target: 5, filter: { weapon: "spark" } })).success).toBe(false);
    expect(taskDefSchema.safeParse(row({ kind: "friends", target: 5 })).success).toBe(true);
    expect(taskDefSchema.safeParse(row({ kind: "account_level", target: 10, filter: { difficulty: "hard" } })).success).toBe(false);
    expect(taskDefSchema.safeParse(row({ kind: "account_level", target: 10 })).success).toBe(true);
  });

  it("обновляются при открытии витрины, а витрина показывает только достижения: у ежедневного эти виды — отказ", () => {
    expect(taskDefSchema.safeParse(row({ kind: "friends", target: 5, period: "daily", taskId: "daily_friends" })).success).toBe(false);
    expect(taskDefSchema.safeParse(row({ kind: "account_level", target: 10, period: "weekly", taskId: "weekly_level" })).success).toBe(false);
  });
});

describe("схема избранного", () => {
  it("до трёх различных id; пустой список очищает", () => {
    expect(FAVORITES_MAX).toBe(3);
    expect(favoritesSchema.safeParse({ ids: [] }).success).toBe(true);
    expect(favoritesSchema.safeParse({ ids: ["ach_a1"] }).success).toBe(true);
    expect(favoritesSchema.safeParse({ ids: ["ach_a1", "ach_b2", "ach_c3"] }).success).toBe(true);
  });

  it("четыре, повтор, id не по шаблону, чужие поля и не массив — отказ", () => {
    expect(favoritesSchema.safeParse({ ids: ["ach_a1", "ach_b2", "ach_c3", "ach_d4"] }).success).toBe(false);
    expect(favoritesSchema.safeParse({ ids: ["ach_a1", "ach_a1"] }).success).toBe(false);
    expect(favoritesSchema.safeParse({ ids: ["Ach A"] }).success).toBe(false);
    expect(favoritesSchema.safeParse({ ids: ["ach_a1"], extra: 1 }).success).toBe(false);
    expect(favoritesSchema.safeParse({ ids: "ach_a1" }).success).toBe(false);
    expect(favoritesSchema.safeParse({}).success).toBe(false);
    expect(favoritesSchema.safeParse(null).success).toBe(false);
  });
});

describe("строка витрины", () => {
  const closed = def({ taskId: "ach_hidden_marathon", kind: "best_survival_sec", target: 1800, title: "Марафонец", coins: 500, category: "mastery", hidden: true, hint: "Продержаться очень, очень долго", prestige: 40 });

  it("закрытое скрытое отдаёт только id, категорию, признак, done: false и подсказку", () => {
    const item = itemOf(closed, { value: 900, done: false, claimed: false }, 12.5);
    expect(item).toEqual({ id: "ach_hidden_marathon", category: "mastery", hidden: true, done: false, hint: "Продержаться очень, очень долго" });
    for (const secret of ["title", "kind", "target", "reward", "value", "prestige", "percent", "filter"]) expect(item, secret).not.toHaveProperty(secret);
  });

  it("открытое скрытое показывается как обычное, со всем", () => {
    const item = itemOf(closed, { value: 1800, done: true, claimed: false }, 0.4);
    expect(item).toEqual({
      id: "ach_hidden_marathon",
      category: "mastery",
      ladder: null,
      rung: null,
      hidden: true,
      kind: "best_survival_sec",
      filter: null,
      title: "Марафонец",
      hint: "Продержаться очень, очень долго",
      target: 1800,
      value: 1800,
      done: true,
      claimed: false,
      reward: { coins: 500, gems: 0, shards: 0 },
      prestige: 40,
      percent: 0.4,
    });
  });

  it("обычное достижение без прогресса — нули, а процент приходит снаружи", () => {
    const plain = def({ taskId: "ach_kills_1k", category: "combat", ladder: "kills", rung: 2, prestige: 10 });
    expect(itemOf(plain, undefined, null)).toMatchObject({ id: "ach_kills_1k", ladder: "kills", rung: 2, value: 0, done: false, claimed: false, percent: null, prestige: 10, hidden: false });
  });

  it("значение не выше цели, даже если строка прогресса записана с запасом", () => {
    const plain = def({ taskId: "ach_kills_1k", category: "combat", prestige: 10 });
    expect(itemOf(plain, { value: 99_999, done: true, claimed: true }, 1)).toMatchObject({ value: 1000, claimed: true });
  });

  it("сводка для профиля: id, название, категория; название может быть пустым — текст по виду цели у клиента", () => {
    const favorite = def({ taskId: "ach_kills_1k", category: "combat", prestige: 10 });
    expect(summaryItemOf(favorite)).toEqual({ id: "ach_kills_1k", title: "Тысячник", category: "combat" });
    expect(summaryItemOf({ ...favorite, title: null })).toEqual({ id: "ach_kills_1k", title: null, category: "combat" });
  });
});
