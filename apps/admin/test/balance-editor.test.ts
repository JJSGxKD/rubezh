import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { createDraft, fetchDiff, fetchDraft, fetchDrafts, fetchVersion, fetchVersions, latestVersion, patchDraft, type DraftChange } from "../src/api/content";
import {
  afterPatch,
  commitValue,
  describeChange,
  describePath,
  enemyCellPath,
  errorLine,
  formatValue,
  indexChanges,
  parsePath,
  readAtPath,
  revertOf,
  setAtPath,
} from "../src/screens/balance/balance-rules";
import { parseSnapshot } from "../src/screens/balance/balance-snapshot";
import { TABS, cellPaths, tablesFor, type CellModel } from "../src/screens/balance/balance-tables";
import { SECTIONS, SECTION_GROUPS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Редактор баланса в панели (tasks/T-0304): таблицы разделов, правка ячейки
// путём T-0303, ошибка 422 строкой под записью, список правок с «Вернуть».
// Логика без DOM: путь из ячейки, подпись правки словами, что делает 422 с
// состоянием, что уходит на сервер при «Вернуть».

const NAMES = {
  "enemy.swarm_rat.name": "Крыса",
  "enemy.dasher_wolf.name": "Волк",
  "enemy.elite_ghoul.name": "Упырь-вожак",
  "enemy.stage.hardened": "Закалённые",
  "weapon.spark.name": "Искра",
  "passive.might.name": "Сила",
  "difficulty.hard.name": "Сложная",
};

function rawSnapshot(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    enemies: [
      { id: "swarm_rat", hp: 5, speed: 90, damage: 3, xp: 1, threat: 1, pattern: "swarm" },
      { id: "dasher_wolf", hp: 14, speed: 60, damage: 7, xp: 3, threat: 3, pattern: "dash", params: { telegraphSec: 0.4 }, resist: { cold: 0.4, fire: -0.25 } },
      { id: "elite_ghoul", hp: 260, speed: 38, damage: 14, xp: 25, rank: "elite", pattern: "chase" },
    ],
    stages: [
      { fromSec: 0, weight: 1, hpMul: 1, damageMul: 1, speedMul: 1, xpMul: 1 },
      { fromSec: 150, weight: 0.55, hpMul: 1.9, damageMul: 1.25, speedMul: 1.06, xpMul: 2, nameKey: "enemy.stage.hardened" },
    ],
    weapons: [
      {
        id: "spark",
        behavior: "projectile_nearest",
        nameKey: "weapon.spark.name",
        descriptionKey: "weapon.spark.description",
        levels: [
          { damage: 6, cooldownSec: 0.3 },
          { damage: 7, cooldownSec: 0.28, projectiles: 2 },
          { damage: 8, cooldownSec: 0.26, projectiles: 2, pierce: 1 },
        ],
      },
    ],
    passives: [{ id: "might", nameKey: "passive.might.name", descriptionKey: "passive.might.description", category: "attack", stat: "damage", op: "mul", levels: [1.1, 1.2, 1.3] }],
    levelCurve: { baseXp: 5, growth: 1.22, late: { fromLevel: 20, growth: 1.1 } },
    loadoutLimits: { weapons: 4, passives: { attack: 3, defense: 3, mobility: 2 } },
    accountUnlocks: [
      { level: 1, weapons: ["spark"], passives: ["might"], slots: { weapons: 2, passives: { attack: 1, defense: 1, mobility: 1 } } },
      { level: 4, weapons: ["storm"] },
    ],
    timeline: [
      { fromSec: 0, spawns: [{ enemy: "swarm_rat", perSec: 2.2 }] },
      {
        fromSec: 90,
        maxAlive: 80,
        spawns: [
          { enemy: "swarm_rat", perSec: 2.2 },
          { enemy: "dasher_wolf", perSec: 0.5, burst: 4 },
        ],
        events: [{ kind: "ring", enemy: "elite_ghoul", count: 1 }],
      },
    ],
    endlessCurve: {
      fromSec: 600,
      segmentSec: 30,
      threatPerSec: 12,
      threatGrowth: 1.05,
      maxAlive: 120,
      hpGrowth: 1.04,
      damageGrowth: 1.03,
      pool: ["swarm_rat", "dasher_wolf"],
      startTypes: 2,
      typesPerSegment: 1,
      mixSize: 2,
      events: [{ everySegments: 4, kind: "ring", enemy: "elite_ghoul", count: 2 }],
    },
    drops: {
      gems: { maxPerKill: 4 },
      medkits: { chance: 0.02, eliteChance: 0.2, healRatio: 0.25, maxOnField: 2 },
      magnets: { chance: 0.01, eliteChance: 0.1, maxOnField: 1 },
      dynamite: { chance: 0.005, eliteChance: 0.05, maxOnField: 1, radiusUnits: 180, eliteHpRatio: 0.3 },
      freeze: { chance: 0.004, eliteChance: 0.04, maxOnField: 1, durationSec: 4, bossDurationRatio: 0.5 },
    },
    chests: {
      opening: [1, 3, 1, 5],
      sizes: [
        { size: 1, weight: 87 },
        { size: 3, weight: 10 },
        { size: 5, weight: 3 },
      ],
      bossMinSize: 3,
      ownedWeightMul: 3,
      lowHpRatio: 0.7,
      xpRatio: 0.5,
      maxOnField: 2,
      late: { afterSec: 600, sizes: [{ size: 1, weight: 95 }], bossMinSize: 3 },
    },
    difficulties: [{ id: "hard", nameKey: "difficulty.hard.name", descriptionKey: "difficulty.hard.description", enemyHpMul: 1.4, enemyDamageMul: 1.3, spawnRateMul: 1.2, maxAliveMul: 1.1 }],
  };
}

function snapshot() {
  const parsed = parseSnapshot(rawSnapshot());
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.snapshot;
}

describe("путь правки из ячейки", () => {
  it("враг — по id, как на сервере", () => {
    expect(enemyCellPath("dasher_wolf", "damage")).toBe("enemies[id=dasher_wolf].damage");
  });

  it("таблица врагов кладёт в ячейку урона именно этот путь", () => {
    const [table] = tablesFor("enemies", snapshot(), NAMES);
    const wolf = table?.rows.find((row) => row.title === "Волк");
    const paths = wolf === undefined ? [] : cellPaths(wolf);
    expect(paths).toContain("enemies[id=dasher_wolf].damage");
    expect(paths).toContain("enemies[id=dasher_wolf].hp");
    // стойкость — по стихии, тоже числом
    expect(paths).toContain("enemies[id=dasher_wolf].resist.cold");
  });

  it("враги без имени в словаре подписаны id, а не пустотой; ранг — меткой", () => {
    const [table] = tablesFor("enemies", snapshot(), {});
    expect(table?.rows.map((row) => row.title)).toContain("dasher_wolf");
    const ghoul = tablesFor("enemies", snapshot(), NAMES)[0]?.rows.find((row) => row.title === "Упырь-вожак");
    expect(ghoul?.badges).toContain("элита");
  });

  it("у каждого раздела есть таблица, и каждая ячейка с путём этот путь читает из снимка", () => {
    const parsed = snapshot();
    const raw = rawSnapshot();
    for (const tab of TABS) {
      const tables = tablesFor(tab.id, parsed, NAMES);
      expect(tables.length, tab.id).toBeGreaterThan(0);
      for (const table of tables) {
        for (const row of table.rows) {
          for (const path of cellPaths(row)) expect(readAtPath(raw, path), `${tab.id}: ${path}`).not.toBeUndefined();
        }
      }
    }
  });

  it("восемь разделов: враги, ступени, таймлайн, оружие, навыки, открытия, подборы и сундуки, опыт и сложность", () => {
    expect(TABS.map((tab) => tab.title)).toEqual(["Враги", "Ступени", "Таймлайн", "Оружие", "Навыки", "Открытия", "Подборы и сундуки", "Опыт и сложность"]);
  });

  it("оружие — уровни строками; поле, которого на уровне нет, правке не подлежит", () => {
    const [table] = tablesFor("weapons", snapshot(), NAMES);
    const levels = table?.rows.filter((row) => !row.heading) ?? [];
    expect(levels).toHaveLength(3);
    expect(cellPaths(levels[1] as NonNullable<(typeof levels)[number]>)).toContain("weapons[id=spark].levels[1].projectiles");
    expect(cellPaths(levels[0] as NonNullable<(typeof levels)[number]>)).not.toContain("weapons[id=spark].levels[0].projectiles");
  });

  it("таймлайн: отрезки и кривая бесконечного режима — двумя таблицами", () => {
    const tables = tablesFor("timeline", snapshot(), NAMES);
    expect(tables).toHaveLength(2);
    const paths = (tables[0]?.rows ?? []).flatMap(cellPaths);
    expect(paths).toContain("timeline[1].spawns[1].perSec");
    expect(paths).toContain("timeline[1].spawns[1].burst");
    expect(paths).toContain("timeline[1].events[0].count");
    expect((tables[1]?.rows ?? []).flatMap(cellPaths)).toContain("endlessCurve.threatGrowth");
  });

  it("поведение — выбор из списка, стихия стойкости не выбирается: только числа", () => {
    const [table] = tablesFor("enemies", snapshot(), NAMES);
    const row = table?.rows.find((candidate) => candidate.title === "Волк");
    const select = row?.cells.find((cell): cell is Extract<CellModel, { kind: "select" }> => cell.kind === "select");
    expect(select?.path).toBe("enemies[id=dasher_wolf].pattern");
    expect(select?.options.map((option) => option.value)).toEqual(["swarm", "chase", "dash", "orbit", "exploder", "splitter", "rush", "cordon"]);
  });
});

describe("путь: разбор и подстановка", () => {
  it("звенья: ключ, индекс, поле=значение", () => {
    expect(parsePath("timeline[3].spawns[0].perSec")).toEqual([
      { kind: "key", name: "timeline" },
      { kind: "index", index: 3 },
      { kind: "key", name: "spawns" },
      { kind: "index", index: 0 },
      { kind: "key", name: "perSec" },
    ]);
    expect(parsePath("enemies[id=swarm_rat].hp")?.[1]).toEqual({ kind: "find", field: "id", value: "swarm_rat" });
    expect(parsePath("enemies[")).toBeNull();
    expect(parsePath("")).toBeNull();
  });

  it("setAtPath ставит значение в копию, исходный снимок не трогает", () => {
    const raw = rawSnapshot();
    const next = setAtPath(raw, "enemies[id=dasher_wolf].damage", 9);
    expect(readAtPath(next, "enemies[id=dasher_wolf].damage")).toBe(9);
    expect(readAtPath(raw, "enemies[id=dasher_wolf].damage")).toBe(7);
  });

  it("не тот путь — снимок возвращается как был", () => {
    const raw = rawSnapshot();
    expect(setAtPath(raw, "enemies[id=nobody].damage", 9)).toBe(raw);
  });
});

describe("подпись правки словами", () => {
  const change = (path: string, from: unknown, to: unknown): DraftChange => ({ path, from, to });

  it("«Волк · урон 7 → 9»", () => {
    expect(describeChange(change("enemies[id=dasher_wolf].damage", 7, 9), snapshot(), NAMES)).toBe("Волк · урон 7 → 9");
  });

  it("дробные — с запятой; без имени в словаре — id", () => {
    expect(describeChange(change("stages[1].weight", 0.55, 0.6), snapshot(), NAMES)).toBe("Закалённые · вес 0,55 → 0,6");
    expect(describeChange(change("enemies[id=dasher_wolf].speed", 60, 70), snapshot(), {})).toBe("dasher_wolf · скорость 60 → 70");
  });

  it("оружие, навык, отрезок таймлайна и кривая читаются по-человечески", () => {
    const parsed = snapshot();
    expect(describeChange(change("weapons[id=spark].levels[2].damage", 8, 9), parsed, NAMES)).toBe("Искра · уровень 3 · урон 8 → 9");
    expect(describeChange(change("passives[id=might].levels[1]", 1.2, 1.25), parsed, NAMES)).toBe("Сила · уровень 2 · значение 1,2 → 1,25");
    expect(describeChange(change("timeline[1].spawns[1].perSec", 0.5, 0.7), parsed, NAMES)).toBe("Таймлайн · с 1:30 · Волк · темп 0,5 → 0,7");
    expect(describeChange(change("endlessCurve.threatGrowth", 1.05, 1.06), parsed, NAMES)).toBe("Бесконечный режим · рост угрозы 1,05 → 1,06");
  });

  it("незнакомый путь не теряется: показывается как есть", () => {
    expect(describeChange(change("somethingNew.field", 1, 2), snapshot(), NAMES)).toBe("somethingNew.field 1 → 2");
  });

  it("значение, которого раньше не было, — «не было»", () => {
    expect(describeChange(change("enemies[id=swarm_rat].threat", null, 2), snapshot(), NAMES)).toBe("Крыса · угроза → 2 (раньше не было)");
  });

  it("путь без значения называется словами, без стрелки", () => {
    expect(describePath("enemies[id=dasher_wolf].damage", snapshot(), NAMES)).toBe("Волк · урон");
  });

  it("правки индексируются по пути — по ним ячейка узнаёт, что изменена и что было", () => {
    const index = indexChanges([change("enemies[id=dasher_wolf].damage", 7, 9)]);
    expect(index.get("enemies[id=dasher_wolf].damage")?.from).toBe(7);
    expect(index.has("enemies[id=dasher_wolf].hp")).toBe(false);
  });
});

describe("значение из ячейки", () => {
  it("число с запятой и точкой; пустое и мусор — не число", () => {
    expect(commitValue("9")).toBe(9);
    expect(commitValue(" 0,55 ")).toBe(0.55);
    expect(commitValue("0.55")).toBe(0.55);
    expect(commitValue("-0,25")).toBe(-0.25);
    expect(commitValue("")).toBeNull();
    expect(commitValue("abc")).toBeNull();
    expect(commitValue("Infinity")).toBeNull();
    expect(commitValue("1 2")).toBeNull();
  });

  it("форматирование для таблицы", () => {
    expect(formatValue(7)).toBe("7");
    expect(formatValue(0.55)).toBe("0,55");
    expect(formatValue("dash")).toBe("dash");
    expect(formatValue(null)).toBe("не было");
  });
});

describe("ошибка сервера под записью", () => {
  const typed = { path: "enemies[id=dasher_wolf].damage", typed: "0", wasText: "7" };
  const rejected = {
    ok: false as const,
    error: { kind: "rejected" as const, status: 422, code: "content_value_invalid", message: "enemies[id=dasher_wolf].damage: должно быть не меньше 1", requestId: null, reason: null },
  };

  it("422 — снимок остаётся тем же объектом, ошибка запоминается вместе с введённым", () => {
    const before = { snapshot: rawSnapshot(), errors: {} };
    const after = afterPatch(before, typed, rejected, NAMES);
    expect(after.snapshot).toBe(before.snapshot);
    expect(after.errors["enemies[id=dasher_wolf].damage"]).toEqual({ typed: "0", message: "Волк · урон: должно быть не меньше 1", was: "7" });
  });

  it("строка ошибки — текст сервера и «Было 7»", () => {
    const state = afterPatch({ snapshot: rawSnapshot(), errors: {} }, typed, rejected, NAMES);
    expect(errorLine(state.errors["enemies[id=dasher_wolf].damage"] as NonNullable<(typeof state.errors)[string]>)).toBe("Волк · урон: должно быть не меньше 1. Было 7.");
  });

  it("успех — значение в снимке, ошибка этой ячейки снята, чужие остаются", () => {
    const other = { typed: "x", message: "m", was: "1" };
    const before = { snapshot: rawSnapshot(), errors: { "enemies[id=dasher_wolf].damage": { typed: "0", message: "m", was: "7" }, "enemies[id=swarm_rat].hp": other } };
    const ok = {
      ok: true as const,
      data: { draftId: "d", path: "enemies[id=dasher_wolf].damage", from: 7, to: 9, changed: true, snapshotHash: "h", updatedAt: "2026-11-01T00:00:00.000Z" },
    };
    const after = afterPatch(before, { ...typed, typed: "9" }, ok, NAMES);
    expect(readAtPath(after.snapshot, "enemies[id=dasher_wolf].damage")).toBe(9);
    expect(after.errors).toEqual({ "enemies[id=swarm_rat].hp": other });
  });

  it("сбой не 422 (нет связи) — тоже не трогает снимок, но ошибка в строке не рисуется", () => {
    const before = { snapshot: rawSnapshot(), errors: {} };
    const offline = { ok: false as const, error: { kind: "offline" as const, status: null, code: null, message: "Нет связи", requestId: null, reason: null } };
    const after = afterPatch(before, typed, offline, NAMES);
    expect(after.snapshot).toBe(before.snapshot);
    expect(after.errors).toEqual({});
  });

  it("422 уходит с сервера по PATCH, и в клиенте это отказ формы", async () => {
    const { fetch, calls } = fakeFetch(json(422, { error: { code: "content_value_invalid", message: "enemies[id=dasher_wolf].damage: должно быть не меньше 1" } }));
    const result = await patchDraft(new AdminApi(fetch), "5f1f2a0e-6f3b-4c58-8a7e-0b6a5b0f1c11", "enemies[id=dasher_wolf].damage", 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("rejected");
    expect(calls[0]?.url).toBe("/api/v1/admin/content/drafts/5f1f2a0e-6f3b-4c58-8a7e-0b6a5b0f1c11");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ path: "enemies[id=dasher_wolf].damage", value: 0 });
  });
});

describe("«Вернуть»", () => {
  it("шлёт прежнее значение по тому же пути", async () => {
    const change: DraftChange = { path: "enemies[id=dasher_wolf].damage", from: 7, to: 9 };
    const request = revertOf(change);
    expect(request).toEqual({ path: "enemies[id=dasher_wolf].damage", value: 7 });
    const { fetch, calls } = fakeFetch(json(200, { data: { draftId: "d", path: change.path, from: 9, to: 7, changed: true, snapshotHash: "h", updatedAt: "2026-11-01T00:00:00.000Z" } }));
    const result = await patchDraft(new AdminApi(fetch), "5f1f2a0e-6f3b-4c58-8a7e-0b6a5b0f1c11", request?.path ?? "", request?.value);
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ path: change.path, value: 7 });
  });

  it("поля в основе не было — вернуть правкой нельзя: сервер не умеет убирать поле", () => {
    expect(revertOf({ path: "enemies[id=swarm_rat].threat", from: null, to: 2 })).toBeNull();
  });

  it("значение не числом (выбор из списка) возвращается так же", () => {
    expect(revertOf({ path: "enemies[id=swarm_rat].pattern", from: "swarm", to: "chase" })).toEqual({ path: "enemies[id=swarm_rat].pattern", value: "swarm" });
  });
});

describe("клиент контента", () => {
  const ID = "5f1f2a0e-6f3b-4c58-8a7e-0b6a5b0f1c11";
  const summary = { draftId: ID, baseVersionNo: 3, title: "Волки", author: "8f7c1c1e-7f0a-4b8e-9d7e-1c2b3a4d5e6f", updatedAt: "2026-11-01T10:00:00.000Z", archivedAt: null };

  it("версии и черновики — по своим адресам; последняя версия — с наибольшим номером", async () => {
    const version = { versionNo: 3, contentHash: "abc", schemaVersion: 1, source: "repo", createdBy: null, createdAt: "2026-10-21T18:04:00.000Z", publishedAt: null };
    const { fetch, calls } = fakeFetch(
      json(200, { data: [{ ...version, versionNo: 1 }, version, { ...version, versionNo: 2 }] }),
      json(200, { data: { ...version, snapshot: {}, jsonSchema: {}, names: NAMES } }),
      json(200, { data: [summary] }),
    );
    const api = new AdminApi(fetch);
    const versions = await fetchVersions(api);
    expect(versions.ok && latestVersion(versions.data)?.versionNo).toBe(3);
    const full = await fetchVersion(api, 3);
    expect(full.ok && full.data.names["enemy.dasher_wolf.name"]).toBe("Волк");
    await fetchDrafts(api);
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/admin/content/versions", "/api/v1/admin/content/versions/3", "/api/v1/admin/content/drafts"]);
  });

  it("новый черновик — POST с названием; чтение черновика и разницы — GET", async () => {
    const { fetch, calls } = fakeFetch(
      json(201, { data: { ...summary, snapshotHash: "h" } }),
      json(200, { data: { ...summary, snapshotHash: "h", snapshot: rawSnapshot(), lastCheck: null } }),
      json(200, { data: { baseVersionNo: 3, changes: [{ path: "enemies[id=dasher_wolf].damage", from: 7, to: 9 }], truncated: false } }),
    );
    const api = new AdminApi(fetch);
    const created = await createDraft(api, "Волки");
    expect(created.ok && created.data.draftId).toBe(ID);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: "Волки" });
    const draft = await fetchDraft(api, ID);
    expect(draft.ok && draft.data.baseVersionNo).toBe(3);
    const diff = await fetchDiff(api, ID);
    expect(diff.ok && diff.data.changes).toHaveLength(1);
    expect(calls[2]?.url).toBe(`/api/v1/admin/content/drafts/${ID}/diff`);
  });

  it("ответ не той формы — отказ «не разобрался», а не таблица с пустотой", async () => {
    const { fetch } = fakeFetch(json(200, { data: [{ versionNo: "три" }] }));
    const result = await fetchVersions(new AdminApi(fetch));
    expect(result.ok).toBe(false);
  });
});

describe("снимок для таблиц", () => {
  it("разбирается схемой; не тот снимок — сообщение, а не падение", () => {
    expect(parseSnapshot(rawSnapshot()).ok).toBe(true);
    const broken = { ...rawSnapshot(), enemies: "много" };
    const result = parseSnapshot(broken);
    expect(result.ok).toBe(false);
    expect(parseSnapshot(null).ok).toBe(false);
  });
});

describe("раздел в меню", () => {
  it("«Баланс» — в группе «Контент», читать — content.view", () => {
    const group = SECTION_GROUPS.find((candidate) => candidate.title === "Контент");
    expect(group?.sections.map((section) => section.id)).toContain("balance");
    expect(SECTIONS.find((section) => section.id === "balance")?.permission).toBe("content.view");
  });
});
