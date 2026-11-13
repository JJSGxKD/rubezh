import { describe, expect, it } from "vitest";
import {
  DYNAMIC_TARGET_KINDS,
  NO_ACHIEVEMENT_FIELDS,
  RUN_KINDS,
  STATE_KINDS,
  TASK_KIND_IDS,
  filterKeyOf,
  isRunKind,
  isStateKind,
  masterIdsOf,
  taskDefSchema,
  withDynamicTargets,
  type TaskDef,
  type TaskRun,
} from "../src/modules/tasks/task-rules.js";

/**
 * Достижения v2 (tasks/T-0322), чистые функции: испытания мастерства и убийства
 * стихией считаются по счётчикам итога забега, «Коллекционер» — по выполненным
 * «Мастерам оружия» и сам знает свою цель.
 */

function run(patch: Partial<TaskRun> = {}): TaskRun {
  return {
    difficulty: "hard",
    mode: "standard",
    survivalSec: 700,
    level: 22,
    enemiesKilled: 400,
    cheats: false,
    verdict: "ok",
    weapons: [{ id: "spark", level: 3 }],
    boosts: [],
    xpCollected: 600,
    counters: null,
    ...patch,
  } as TaskRun;
}

function counters(patch: Partial<NonNullable<TaskRun["counters"]>> = {}): NonNullable<TaskRun["counters"]> {
  return { bossKills: 0, eliteKills: 0, chestsOpened: 0, rareChests: 0, crystals: 0, noHitSec: 0, noKillSec: 0, killsByElement: {}, ...patch };
}

/** Достижение так, как его хранит каталог. */
function achievement(taskId: string, patch: Partial<TaskDef> = {}): TaskDef {
  return {
    taskId,
    period: "achievement",
    kind: "kills",
    params: null,
    filter: null,
    tier: null,
    target: 100,
    title: "Достижение",
    coins: 100,
    gems: 0,
    shards: 0,
    passPoints: 0,
    sort: 0,
    active: true,
    limit: null,
    image: null,
    ...NO_ACHIEVEMENT_FIELDS,
    category: "collection",
    prestige: 10,
    ...patch,
  };
}

describe("испытания: «Без единой царапины» и «Пацифист»", () => {
  it("оба — «максимум» по итогу забега: лучший забег, а не сумма", () => {
    expect(RUN_KINDS.no_hit_sec.op).toBe("max");
    expect(RUN_KINDS.no_kill_sec.op).toBe("max");
    expect(isRunKind("no_hit_sec")).toBe(true);
    expect(isRunKind("no_kill_sec")).toBe(true);
    expect(TASK_KIND_IDS).toContain("no_hit_sec");
    expect(TASK_KIND_IDS).toContain("no_kill_sec");
  });

  it("no_hit_sec: забег с noHitSec 610 даёт 610, без счётчиков (null) — 0", () => {
    expect(RUN_KINDS.no_hit_sec.measure(run({ counters: counters({ noHitSec: 610 }) }))).toBe(610);
    expect(RUN_KINDS.no_hit_sec.measure(run({ counters: null }))).toBe(0);
    expect(RUN_KINDS.no_hit_sec.measure(run({ counters: counters() }))).toBe(0);
  });

  it("no_kill_sec: забег с noKillSec 75 даёт 75, без счётчиков (null) — 0", () => {
    expect(RUN_KINDS.no_kill_sec.measure(run({ counters: counters({ noKillSec: 75 }) }))).toBe(75);
    expect(RUN_KINDS.no_kill_sec.measure(run({ counters: null }))).toBe(0);
  });

  it("испытания не путают свои счётчики: серия без попаданий не засчитывает «Пацифиста»", () => {
    const sample = run({ counters: counters({ noHitSec: 900, noKillSec: 10 }) });
    expect(RUN_KINDS.no_hit_sec.measure(sample)).toBe(900);
    expect(RUN_KINDS.no_kill_sec.measure(sample)).toBe(10);
  });

  it("схема: достижение без фильтра принимается, с фильтром — отказ", () => {
    for (const kind of ["no_hit_sec", "no_kill_sec"] as const) {
      expect(filterKeyOf(kind), kind).toBeNull();
      expect(taskDefSchema.safeParse(achievement("ach_x_trial", { kind, target: 60, category: "mastery" })).success, kind).toBe(true);
      expect(taskDefSchema.safeParse(achievement("ach_x_trial", { kind, target: 60, category: "mastery", filter: { element: "fire" } })).success, kind).toBe(false);
    }
  });
});

describe("убийства стихией", () => {
  const sample = run({ counters: counters({ killsByElement: { fire: 200, cold: 50 } }) });

  it("копится суммой за все забеги", () => {
    expect(RUN_KINDS.element_kills.op).toBe("sum");
    expect(isRunKind("element_kills")).toBe(true);
    expect(TASK_KIND_IDS).toContain("element_kills");
  });

  it("с фильтром fire берёт только огонь, с cold — только холод", () => {
    expect(RUN_KINDS.element_kills.measure(sample, { element: "fire" })).toBe(200);
    expect(RUN_KINDS.element_kills.measure(sample, { element: "cold" })).toBe(50);
  });

  it("нет ключа стихии — ноль; нет счётчиков — ноль; нет фильтра — ноль, а не сумма всех стихий", () => {
    expect(RUN_KINDS.element_kills.measure(sample, { element: "poison" })).toBe(0);
    expect(RUN_KINDS.element_kills.measure(run({ counters: null }), { element: "fire" })).toBe(0);
    expect(RUN_KINDS.element_kills.measure(sample, null)).toBe(0);
    expect(RUN_KINDS.element_kills.measure(sample)).toBe(0);
  });

  it("схема: без фильтра — отказ, фильтр оружием или сложностью — отказ, стихия — принимается", () => {
    expect(filterKeyOf("element_kills")).toBe("element");
    const base = { kind: "element_kills" as const, target: 500, category: "combat" as const, ladder: "fire_kills", rung: 1 };
    expect(taskDefSchema.safeParse(achievement("ach_fire_500", base)).success).toBe(false);
    expect(taskDefSchema.safeParse(achievement("ach_fire_500", { ...base, filter: { weapon: "hearth" } })).success).toBe(false);
    expect(taskDefSchema.safeParse(achievement("ach_fire_500", { ...base, filter: { difficulty: "hard" } })).success).toBe(false);
    expect(taskDefSchema.safeParse(achievement("ach_fire_500", { ...base, filter: { element: "water" } as never })).success).toBe(false);
    expect(taskDefSchema.safeParse(achievement("ach_fire_500", { ...base, filter: { element: "fire" } })).success).toBe(true);
  });
});

describe("«Коллекционер»: вид weapon_masters", () => {
  it("забегом не двигается: это состояние игрока, а не вид забега", () => {
    expect(isRunKind("weapon_masters")).toBe(false);
    expect(isStateKind("weapon_masters")).toBe(true);
    expect(STATE_KINDS.weapon_masters.op).toBe("max");
    expect(TASK_KIND_IDS).toContain("weapon_masters");
  });

  it("цель считается сама — только у него", () => {
    expect([...DYNAMIC_TARGET_KINDS]).toEqual(["weapon_masters"]);
  });

  it("схема: достижение без фильтра принимается; ежедневное и с фильтром — отказ", () => {
    const collector = achievement("ach_collector", { kind: "weapon_masters", target: 1 });
    expect(taskDefSchema.safeParse(collector).success).toBe(true);
    expect(taskDefSchema.safeParse({ ...collector, filter: { weapon: "spark" } }).success).toBe(false);
    expect(taskDefSchema.safeParse({ ...collector, period: "daily", category: null, prestige: 0 }).success).toBe(false);
  });

  const masters = [
    achievement("ach_weapon_spark", { kind: "weapon_runs", filter: { weapon: "spark" }, target: 5 }),
    achievement("ach_weapon_knife", { kind: "weapon_runs", filter: { weapon: "knife" }, target: 5 }),
    achievement("ach_weapon_meteor", { kind: "weapon_runs", filter: { weapon: "meteor" }, target: 5 }),
  ];
  const collector = achievement("ach_collector", { kind: "weapon_masters", target: 1 });

  it("masterIdsOf: все «Мастера оружия» каталога, и только они", () => {
    const rest = [
      achievement("ach_runs_10", { kind: "runs", target: 10 }),
      // ежедневное задание на оружие «Мастером» не считается
      achievement("daily_weapon", { period: "daily", kind: "weapon_runs", filter: { weapon: "spark" }, category: null, prestige: 0 }),
    ];
    expect(masterIdsOf([...masters, collector, ...rest])).toEqual(["ach_weapon_spark", "ach_weapon_knife", "ach_weapon_meteor"]);
    expect(masterIdsOf([collector])).toEqual([]);
  });

  it("withDynamicTargets: цель «Коллекционера» — число «Мастеров», хранимая цель строки не читается", () => {
    const [spark, , , result] = withDynamicTargets([...masters, collector]);
    expect(result?.target).toBe(3);
    expect(spark?.target).toBe(5);
    expect(withDynamicTargets([...masters, collector, achievement("ach_weapon_x", { kind: "weapon_runs", filter: { weapon: "sting" }, target: 5 }), { ...collector, target: 99 }]).at(-1)?.target).toBe(4);
  });

  it("withDynamicTargets: «Мастеров» нет — цель не падает до нуля (схема запрещает ноль)", () => {
    expect(withDynamicTargets([collector])[0]?.target).toBe(1);
  });

  it("withDynamicTargets не меняет исходные строки и не трогает остальные виды", () => {
    const input = [...masters, collector];
    const before = JSON.stringify(input);
    withDynamicTargets(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(withDynamicTargets(masters)).toEqual(masters);
  });

  it("выключенный «Мастер» цель не поднимает: считаются только включённые строки", () => {
    const off = achievement("ach_weapon_off", { kind: "weapon_runs", filter: { weapon: "sting" }, target: 5, active: false });
    expect(withDynamicTargets([...masters, off, collector]).at(-1)?.target).toBe(3);
  });
});
