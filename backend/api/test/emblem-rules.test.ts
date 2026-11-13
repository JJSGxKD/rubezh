import { describe, expect, it } from "vitest";
import {
  EMBLEM_IDS,
  SEASON_STEPS,
  STATUS_ORDER,
  emblemChoiceSchema,
  emblemGroupOf,
  heldSeason,
  heldStatus,
  isEmblemDef,
  isVipActive,
  publicEmblemOf,
  shownEmblem,
  type StatusState,
} from "../src/modules/achievements/emblem-rules.js";
import { ITEM_RARITIES } from "../src/modules/items/item-catalog.js";
import {
  EMBLEM_CATEGORIES,
  EMBLEM_KINDS,
  EMBLEM_TIERS,
  NO_ACHIEVEMENT_FIELDS,
  RUN_KINDS,
  STATE_KINDS,
  TASK_KIND_IDS,
  isEmblemKind,
  isRunKind,
  isStateKind,
  taskDefSchema,
  type TaskDef,
} from "../src/modules/tasks/task-rules.js";

/**
 * Знаки у имени, чистые правила (tasks/T-0235, docs/35-stage4-plan.md Р149):
 * кто какой знак держит, какой показывается в списках и как знак входит в
 * каталог заданий. Без базы: живые запросы — в `emblems.integration.test.ts`.
 */

const NOTHING: StatusState = { vipActive: false, testerAt: null, supporterAt: null, hasRole: false };
const WHEN = new Date(Date.UTC(2026, 9, 24, 12));

describe("статусные знаки: кто держит", () => {
  it("VIP активен — emb_vip; истёк — нет", () => {
    expect(heldStatus({ ...NOTHING, vipActive: true })).toEqual(new Set(["emb_vip"]));
    expect(heldStatus({ ...NOTHING, vipActive: false })).toEqual(new Set());
  });

  it("тестер и меценат вместе — оба знака", () => {
    expect(heldStatus({ ...NOTHING, testerAt: WHEN, supporterAt: WHEN })).toEqual(new Set(["emb_tester", "emb_supporter"]));
  });

  it("по одному: только тестер, только меценат", () => {
    expect(heldStatus({ ...NOTHING, testerAt: WHEN })).toEqual(new Set(["emb_tester"]));
    expect(heldStatus({ ...NOTHING, supporterAt: WHEN })).toEqual(new Set(["emb_supporter"]));
  });

  it("есть роль — emb_team", () => {
    expect(heldStatus({ ...NOTHING, hasRole: true })).toEqual(new Set(["emb_team"]));
  });

  it("ничего нет — пусто; всё есть — четыре знака", () => {
    expect(heldStatus(NOTHING)).toEqual(new Set());
    expect(heldStatus({ vipActive: true, testerAt: WHEN, supporterAt: WHEN, hasRole: true })).toEqual(new Set(["emb_team", "emb_vip", "emb_supporter", "emb_tester"]));
  });

  it("статус не выдаёт сезонных знаков", () => {
    for (const id of heldStatus({ vipActive: true, testerAt: WHEN, supporterAt: WHEN, hasRole: true })) expect(id.startsWith("emb_season_"), id).toBe(false);
  });
});

describe("VIP: активен, пока конец периода позже момента", () => {
  it("конец позже — активен; ровно сейчас и раньше — нет; периодов не было — нет", () => {
    expect(isVipActive(new Date(WHEN.getTime() + 1), WHEN)).toBe(true);
    expect(isVipActive(WHEN, WHEN)).toBe(false);
    expect(isVipActive(new Date(WHEN.getTime() - 1), WHEN)).toBe(false);
    expect(isVipActive(null, WHEN)).toBe(false);
  });
});

describe("сезонные знаки: пороги 1 / 10 / 100", () => {
  it("ступени заданы таблицей в порядке от старшей", () => {
    expect(SEASON_STEPS.map((step) => [step.id, step.maxPlace])).toEqual([
      ["emb_season_champion", 1],
      ["emb_season_top10", 10],
      ["emb_season_top100", 100],
    ]);
  });

  it("лучшее место 1 — все три", () => {
    expect(heldSeason(1)).toEqual(new Set(["emb_season_champion", "emb_season_top10", "emb_season_top100"]));
  });

  it("место 7 — топ-10 и топ-100", () => {
    expect(heldSeason(7)).toEqual(new Set(["emb_season_top10", "emb_season_top100"]));
  });

  it("границы: 2 — без чемпиона, 10 — ещё топ-10, 11 — только топ-100, 100 — ещё топ-100", () => {
    expect(heldSeason(2)).toEqual(new Set(["emb_season_top10", "emb_season_top100"]));
    expect(heldSeason(10)).toEqual(new Set(["emb_season_top10", "emb_season_top100"]));
    expect(heldSeason(11)).toEqual(new Set(["emb_season_top100"]));
    expect(heldSeason(100)).toEqual(new Set(["emb_season_top100"]));
  });

  it("место 101 и null — ни одного", () => {
    expect(heldSeason(101)).toEqual(new Set());
    expect(heldSeason(null)).toEqual(new Set());
  });

  it("место, которого не бывает (0, отрицательное, дробное), — ни одного", () => {
    for (const place of [0, -1, 1.5, Number.NaN]) expect(heldSeason(place), String(place)).toEqual(new Set());
  });
});

describe("знак в списках: выбранный, иначе по умолчанию", () => {
  it("порядок по умолчанию: Команда, VIP, Меценат, Тестер", () => {
    expect(STATUS_ORDER).toEqual(["emb_team", "emb_vip", "emb_supporter", "emb_tester"]);
  });

  it("выбран и держится — он", () => {
    expect(shownEmblem("emb_tester", new Set(["emb_tester", "emb_vip"]))).toBe("emb_tester");
    expect(shownEmblem("ach_survive_20", new Set(["ach_survive_20", "emb_vip"]))).toBe("ach_survive_20");
    expect(shownEmblem("emb_season_top10", new Set(["emb_season_top10"]))).toBe("emb_season_top10");
  });

  it("выбран и не держится — первый держимый из порядка по умолчанию", () => {
    expect(shownEmblem("emb_vip", new Set(["emb_tester", "emb_supporter"]))).toBe("emb_supporter");
    expect(shownEmblem("ach_survive_20", new Set(["emb_tester"]))).toBe("emb_tester");
  });

  it("не выбран — тот же порядок по умолчанию", () => {
    expect(shownEmblem(null, new Set(["emb_tester"]))).toBe("emb_tester");
  });

  it("ничего не держит — null", () => {
    expect(shownEmblem(null, new Set())).toBeNull();
    expect(shownEmblem("emb_vip", new Set())).toBeNull();
  });

  it("Команда важнее VIP, VIP важнее Мецената, Меценат важнее Тестера", () => {
    expect(shownEmblem(null, new Set(["emb_vip", "emb_team", "emb_tester"]))).toBe("emb_team");
    expect(shownEmblem(null, new Set(["emb_tester", "emb_vip", "emb_supporter"]))).toBe("emb_vip");
    expect(shownEmblem(null, new Set(["emb_tester", "emb_supporter"]))).toBe("emb_supporter");
  });

  it("по умолчанию берутся только статусные: сезонный и заслуга сами не показываются", () => {
    expect(shownEmblem(null, new Set(["emb_season_champion", "ach_survive_20"]))).toBeNull();
  });
});

describe("группа знака для клиента", () => {
  it("статус и сезон — свои группы, остальные категории достижений — заслуги", () => {
    expect(emblemGroupOf("status")).toBe("status");
    expect(emblemGroupOf("season")).toBe("season");
    for (const category of ["combat", "collection", "mastery", "friends"] as const) expect(emblemGroupOf(category), category).toBe("merit");
  });
});

describe("публичный знак в строке списка", () => {
  const def = { taskId: "emb_vip", title: "VIP", category: "status", emblemTier: "legendary" } as const;

  it("статусный: id, название, редкость и группа; номера сезона нет", () => {
    const mark = publicEmblemOf(def, null);
    expect(mark).toStrictEqual({ id: "emb_vip", title: "VIP", tier: "legendary", category: "status" });
  });

  it("сезонный несёт номер сезона", () => {
    const mark = publicEmblemOf({ taskId: "emb_season_champion", title: "Чемпион", category: "season", emblemTier: "mythic" }, 3);
    expect(mark).toStrictEqual({ id: "emb_season_champion", title: "Чемпион", tier: "mythic", category: "season", season: 3 });
  });

  it("заслуга — группа merit, номер сезона не кладётся, даже если его передали", () => {
    const mark = publicEmblemOf({ taskId: "ach_survive_20", title: "Последний рубеж", category: "mastery", emblemTier: "epic" }, 5);
    expect(mark).toStrictEqual({ id: "ach_survive_20", title: "Последний рубеж", tier: "epic", category: "merit" });
  });

  it("знак «Команда» несёт тон team", () => {
    expect(publicEmblemOf({ taskId: "emb_team", title: "Команда", category: "status", emblemTier: "team" }, null).tier).toBe("team");
  });
});

describe("что считается знаком каталога", () => {
  it("строка со знаком и названием", () => {
    expect(isEmblemDef({ title: "VIP", emblemTier: "legendary" })).toBe(true);
  });

  it("без редкости знака нет, без названия знак безымянный и в каталог не идёт", () => {
    expect(isEmblemDef({ title: "VIP", emblemTier: null })).toBe(false);
    expect(isEmblemDef({ title: null, emblemTier: "epic" })).toBe(false);
  });
});

describe("выбор знака: тело PUT /achievements/emblem", () => {
  it("id или null", () => {
    expect(emblemChoiceSchema.parse({ id: "emb_vip" })).toEqual({ id: "emb_vip" });
    expect(emblemChoiceSchema.parse({ id: null })).toEqual({ id: null });
  });

  it("без id, кривой id, не строка и лишние поля — отказ", () => {
    for (const body of [{}, { id: "DROP TABLE" }, { id: "Emb_Vip" }, { id: 5 }, { id: "emb_vip", extra: 1 }, null, "emb_vip", []]) {
      expect(emblemChoiceSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe("каталог заданий: виды status и season", () => {
  it("новые виды в списке видов, но забег и витрина их не двигают", () => {
    expect([...EMBLEM_KINDS]).toEqual(["status", "season"]);
    for (const kind of EMBLEM_KINDS) {
      expect(TASK_KIND_IDS, kind).toContain(kind);
      expect(isEmblemKind(kind), kind).toBe(true);
      expect(isRunKind(kind), kind).toBe(false);
      expect(isStateKind(kind), kind).toBe(false);
      expect(Object.hasOwn(RUN_KINDS, kind), kind).toBe(false);
      expect(Object.hasOwn(STATE_KINDS, kind), kind).toBe(false);
    }
    expect(isEmblemKind("kills")).toBe(false);
    expect(isEmblemKind("channel")).toBe(false);
  });

  it("редкость знака — шкала предметов и отдельный тон team", () => {
    expect([...EMBLEM_TIERS]).toEqual([...ITEM_RARITIES, "team"]);
    expect([...EMBLEM_CATEGORIES]).toEqual(["status", "season"]);
  });

  const emblemRow = {
    taskId: "emb_vip",
    period: "achievement",
    kind: "status",
    target: 1,
    title: "VIP",
    coins: 0,
    gems: 0,
    shards: 0,
    passPoints: 0,
    sort: 900,
    active: true,
    category: "status",
    hint: "Оформить VIP",
    emblemTier: "legendary",
  };
  const row = (patch: Record<string, unknown> = {}) => ({ ...emblemRow, ...patch });
  const accepted = (patch: Record<string, unknown> = {}) => taskDefSchema.safeParse(row(patch)).success;

  /** Обычное достижение со знаком: награда монетами, как у остальных. */
  const merit = (patch: Record<string, unknown> = {}) => ({
    taskId: "ach_kills_100k",
    period: "achievement",
    kind: "kills",
    target: 100_000,
    title: "Погибель орды",
    coins: 1500,
    gems: 0,
    shards: 0,
    passPoints: 0,
    sort: 130,
    active: true,
    ...NO_ACHIEVEMENT_FIELDS,
    category: "combat",
    ladder: "kills",
    rung: 5,
    prestige: 80,
    emblemTier: "legendary",
    ...patch,
  });

  it("строка знака без награды принимается; награда задания без знака нужна по-прежнему", () => {
    expect(accepted()).toBe(true);
    expect(taskDefSchema.safeParse(merit({ coins: 0 })).success).toBe(false);
  });

  it("у знака статуса или сезона награды, очков и цели больше единицы нет", () => {
    expect(accepted({ coins: 1 })).toBe(false);
    expect(accepted({ gems: 1 })).toBe(false);
    expect(accepted({ shards: 1 })).toBe(false);
    expect(accepted({ passPoints: 1 })).toBe(false);
    expect(accepted({ target: 2 })).toBe(false);
    expect(accepted({ prestige: 5 })).toBe(false);
  });

  it("вид и категория парные: status — status, season — season", () => {
    expect(accepted({ kind: "season", category: "season", taskId: "emb_season_top10" })).toBe(true);
    expect(accepted({ kind: "status", category: "season" })).toBe(false);
    expect(accepted({ kind: "season", category: "status" })).toBe(false);
    expect(accepted({ category: null })).toBe(false);
    expect(accepted({ category: "combat" })).toBe(false);
    // категория знака без одноимённого вида — у обычной цели забега
    expect(taskDefSchema.safeParse(merit({ category: "status" })).success).toBe(false);
    expect(taskDefSchema.safeParse(merit({ category: "season" })).success).toBe(false);
  });

  it("знак статуса или сезона — только достижение, с подсказкой и редкостью", () => {
    expect(accepted({ period: "daily" })).toBe(false);
    expect(accepted({ period: "weekly" })).toBe(false);
    expect(accepted({ hint: null })).toBe(false);
    expect(accepted({ emblemTier: null })).toBe(false);
  });

  it("у знака статуса нет ни фильтра, ни лестницы, ни скрытости, ни ссылки", () => {
    expect(accepted({ ladder: "kills", rung: 1 })).toBe(false);
    expect(accepted({ hidden: true })).toBe(false);
    expect(accepted({ filter: { weapon: "spark" } })).toBe(false);
    expect(accepted({ params: { url: "https://example.com/" } })).toBe(false);
    expect(accepted({ tier: "easy" })).toBe(false);
  });

  it("у знака статуса и сезона нет заказчика, модели оплаты, ставки и удержания", () => {
    // Заказчик продаёт действие вне игры (Р138): знак держат, а не выполняют. Рядом с редкостью знака
    // поля заказчика не уживаются ни по одному из двух правил схемы, ни по CHECK в базе (params у знака пуст).
    expect(accepted({ customer: "Acme", payModel: "cpa", rate: 40 })).toBe(false);
    expect(accepted({ customer: "Acme", payModel: "rs", rate: 1250 })).toBe(false);
    expect(accepted({ holdDays: 1 })).toBe(false);
    expect(accepted({ holdDays: 7 })).toBe(false);
    expect(accepted({ payModel: "cpa" })).toBe(false);
    expect(accepted({ rate: 10 })).toBe(false);
    for (const kind of EMBLEM_KINDS) {
      expect(accepted({ kind, category: kind, customer: "Acme", payModel: "cpa", rate: 40 }), kind).toBe(false);
      expect(accepted({ kind, category: kind, holdDays: 3 }), kind).toBe(false);
    }
    // без полей заказчика — как прежде, а пустые значения берутся умолчаниями
    const parsed = taskDefSchema.parse(row());
    expect(parsed).toMatchObject({ customer: null, payModel: null, rate: null, holdDays: 0 });
    expect(taskDefSchema.safeParse(row({ ...NO_ACHIEVEMENT_FIELDS, category: "status", hint: "Оформить VIP", emblemTier: "legendary" })).success).toBe(true);
  });

  it("у достижения со знаком заказчика тоже нет, а у партнёрской цели с заказчиком знака нет", () => {
    expect(taskDefSchema.safeParse(merit({ customer: "Acme", payModel: "cpa", rate: 40 })).success).toBe(false);
    expect(taskDefSchema.safeParse(merit({ holdDays: 1 })).success).toBe(false);
    const partner = {
      taskId: "p_channel",
      period: "achievement",
      kind: "channel",
      target: 1,
      title: "Канал",
      coins: 10,
      gems: 0,
      shards: 0,
      passPoints: 0,
      sort: 1,
      active: true,
      params: { platform: "telegram", chat: "@example_channel", url: "https://t.me/example_channel" },
      customer: "Acme",
      payModel: "cpa",
      rate: 40,
      holdDays: 3,
    };
    expect(taskDefSchema.safeParse(partner).success).toBe(true);
    expect(taskDefSchema.safeParse({ ...partner, emblemTier: "rare" }).success).toBe(false);
  });

  it("общий литерал пустых полей несёт обе группы: знак у имени и заказчика", () => {
    expect(Object.keys(NO_ACHIEVEMENT_FIELDS).sort()).toEqual(
      ["category", "customer", "emblemTier", "hidden", "hint", "holdDays", "ladder", "payModel", "prestige", "rate", "rung"].sort(),
    );
  });

  it("редкость знака — из шкалы, у достижения принимается любая", () => {
    for (const tier of EMBLEM_TIERS) expect(taskDefSchema.safeParse(merit({ emblemTier: tier })).success, tier).toBe(true);
    expect(taskDefSchema.safeParse(merit({ emblemTier: "gold" })).success).toBe(false);
    expect(taskDefSchema.safeParse(merit({ emblemTier: "" })).success).toBe(false);
  });

  it("без поля знак — null: прежние строки и прежняя панель разбираются", () => {
    const parsed = taskDefSchema.parse(merit({ emblemTier: undefined }));
    expect(parsed.emblemTier).toBeNull();
  });

  it("знак у достижения требует название: безымянного знака в списках не бывает", () => {
    expect(taskDefSchema.safeParse(merit({ title: null })).success).toBe(false);
    expect(taskDefSchema.safeParse(merit({ emblemTier: null, title: null })).success).toBe(true);
  });

  it("знак бывает только у достижений: у ежедневного, недельного и партнёрского — нет", () => {
    const daily = { taskId: "daily_x", period: "daily", kind: "runs", target: 1, title: null, coins: 10, gems: 0, shards: 0, passPoints: 0, sort: 1, active: true, emblemTier: "rare" };
    expect(taskDefSchema.safeParse(daily).success).toBe(false);
    expect(taskDefSchema.safeParse({ ...daily, period: "weekly" }).success).toBe(false);
    const partner = { ...daily, taskId: "p_link", period: "achievement", kind: "link", target: 1, params: { url: "https://example.com/" } };
    expect(taskDefSchema.safeParse(partner).success).toBe(false);
    expect(taskDefSchema.safeParse({ ...partner, emblemTier: null }).success).toBe(true);
  });

  it("тип строки несёт редкость знака", () => {
    const parsed: TaskDef = taskDefSchema.parse(row());
    expect(parsed.emblemTier).toBe("legendary");
    expect(EMBLEM_IDS.vip).toBe("emb_vip");
  });
});
