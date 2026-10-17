import {
  DIFFICULTY_IDS,
  PASSIVE_CATEGORIES,
  type EnemyDef,
  type PassiveDef,
  type WeaponDef,
} from "@bh/shared-types";
import { DEFAULT_DIFFICULTY_ID, DIFFICULTIES } from "../src/content/difficulty";
import { findDifficultyContentProblems } from "../src/game/sim/difficulty";
import { findStageProblems } from "../src/game/sim/stages";
import { describe, expect, it } from "vitest";
import { BALANCE_TARGETS } from "../src/content/balance-targets";
import { CHESTS } from "../src/content/chests";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { ENEMY_STAGES } from "../src/content/stages";
import { MAPS } from "../src/content/maps";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { ACCOUNT_UNLOCKS } from "../src/content/unlocks";
import { WEAPONS } from "../src/content/weapons";
import { findEnemyContentProblems, IMPLEMENTED_PATTERNS } from "../src/game/patterns";
import { findChestsProblems } from "../src/game/sim/chests";
import { findMapContentProblems } from "../src/game/sim/map-types";
import { MAX_PICKUPS, MAX_PICKUPS_OF_KIND } from "../src/game/sim/pickups";
import { findTimelineProblems } from "../src/game/sim/timeline-content";
import { findPassiveContentProblems } from "../src/game/progression/passives";
import { xpForLevel } from "../src/game/progression/levels";
import { findUnlockProblems, unlockLevelOf, unlocksAt } from "../src/game/progression/unlocks";
import { findWeaponContentProblems, IMPLEMENTED_WEAPON_BEHAVIORS } from "../src/game/weapons";
import { createWorld } from "../src/game/sim/world";

// Дешёвые тесты, ловящие опечатки в контенте за миллисекунды
// (docs/17-testing-strategy.md §3.1). Геймдизайнер узнаёт об ошибке из CI
// через минуту, а не из ручного плейтеста через день.

// Паттерны, которых в контенте больше нет: стрелков убрали (Р69, docs/35-stage4-plan.md),
// а код паттерна и снаряды остаются до WP36.
const RETIRED_PATTERNS: readonly string[] = ["kite_and_shoot"];

describe("контент врагов", () => {
  it("не содержит дублирующихся id", () => {
    const ids = ENEMIES.map((enemy) => enemy.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("использует только реализованные паттерны поведения", () => {
    for (const enemy of ENEMIES) {
      expect(IMPLEMENTED_PATTERNS, `враг ${enemy.id}`).toContain(enemy.pattern);
    }
  });

  it("держит числовые поля в осмысленных границах", () => {
    for (const enemy of ENEMIES) {
      expect(enemy.hp, `hp врага ${enemy.id}`).toBeGreaterThan(0);
      expect(enemy.speed, `speed врага ${enemy.id}`).toBeGreaterThan(0);
      expect(enemy.damage, `damage врага ${enemy.id}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("проходит проверку параметров паттернов целиком", () => {
    // Сообщения читает геймдизайнер: пустой список — контент корректен,
    // иначе в выводе теста написано, какой враг и какое поле не так.
    expect(findEnemyContentProblems(ENEMIES)).toEqual([]);
  });

  it("содержит врага на каждом реализованном паттерне, кроме выведенных из контента", () => {
    const used = new Set(ENEMIES.map((enemy) => enemy.pattern));
    for (const pattern of IMPLEMENTED_PATTERNS) {
      if (RETIRED_PATTERNS.includes(pattern)) continue;
      expect(used, `паттерн ${pattern}`).toContain(pattern);
    }
  });

  it("не ставит врагов на выведенные паттерны", () => {
    for (const enemy of ENEMIES) {
      expect(RETIRED_PATTERNS, `враг ${enemy.id}`).not.toContain(enemy.pattern);
    }
  });

  it("не содержит блуждающего огонька ни среди врагов, ни в таймлайне, ни в пуле", () => {
    expect(ENEMIES.map((enemy) => enemy.id)).not.toContain("shooter_wisp");
    for (const segment of TIMELINE) {
      expect(segment.spawns.map((spawn) => spawn.enemy), `отрезок ${segment.fromSec}`).not.toContain("shooter_wisp");
      expect((segment.events ?? []).map((event) => event.enemy), `события ${segment.fromSec}`).not.toContain("shooter_wisp");
    }
    expect(ENDLESS_CURVE.pool).not.toContain("shooter_wisp");
  });

  it("описывает пеших врагов без стрелка по таблице задачи", () => {
    const byId = new Map(ENEMIES.map((enemy) => [enemy.id, enemy]));
    expect(byId.get("bone_walker")).toMatchObject({ pattern: "chase", threat: 2, params: { steeringPerSec: 1.2 } });
    expect(byId.get("bone_walker")?.rank).toBeUndefined();
    expect(byId.get("bone_walker")?.resist).toBeUndefined();
    expect(byId.get("mire_shambler")).toMatchObject({ pattern: "swarm", threat: 5, resist: { fire: 0.4, lightning: -0.4 } });
    expect(byId.get("mire_shambler")?.rank).toBeUndefined();
    expect(byId.get("elite_grave_knight")).toMatchObject({
      pattern: "dash",
      rank: "elite",
      threat: 34,
      resist: { poison: 0.5, fire: -0.4 },
      params: { triggerDistance: 260, telegraphSec: 0.7, dashSpeed: 340, dashDurationSec: 0.8, recoverSec: 1.4 },
    });
    // Стихии атаки у них нет: рою её не дают, а у элиты читается рывок.
    for (const id of ["bone_walker", "mire_shambler", "elite_grave_knight"]) expect(byId.get(id)?.element, id).toBeUndefined();
  });

  it("не даёт опыта меньше за более крепкого рядового", () => {
    const regular = ENEMIES.filter((enemy) => enemy.rank === undefined);
    const byHp = [...regular].sort((a, b) => a.hp - b.hp);
    expect(byHp.find((enemy) => enemy.id === "mire_shambler")!.xp).toBeGreaterThan(byHp.find((enemy) => enemy.id === "bone_walker")!.xp);
  });
});

describe("проверка параметров паттернов", () => {
  const base = { hp: 10, speed: 50, damage: 1, xp: 1 };
  const swarm: EnemyDef = { id: "rat", ...base, pattern: "swarm" };

  function problemsOf(...defs: EnemyDef[]): string[] {
    return findEnemyContentProblems(defs);
  }

  it("ловит делящегося, который ссылается на несуществующего врага", () => {
    const problems = problemsOf({ id: "blob", ...base, pattern: "splitter", params: { children: [{ enemy: "ghost" }] } });
    expect(problems.join("\n")).toMatch(/в children нет врага ghost/);
  });

  it("разрешает матрёшку: делящийся из делящихся, пока цепочка кончается", () => {
    const problems = problemsOf(
      { id: "a", ...base, pattern: "splitter", params: { children: [{ enemy: "b", count: 2 }] } },
      { id: "b", ...base, pattern: "splitter", params: { children: [{ enemy: "rat", count: 2 }] } },
      swarm,
    );
    expect(problems).toEqual([]);
  });

  it("ловит кольцо в распаде — оно множило бы популяцию от одного выстрела", () => {
    const problems = problemsOf(
      { id: "a", ...base, pattern: "splitter", params: { children: [{ enemy: "b" }] } },
      { id: "b", ...base, pattern: "splitter", params: { children: [{ enemy: "a" }] } },
    );
    expect(problems.join("\n")).toMatch(/цепочка распада зациклена/);
  });

  it("ловит слишком глубокую матрёшку: игрок читает ступени, а не лавину", () => {
    const problems = problemsOf(
      { id: "a", ...base, pattern: "splitter", params: { children: [{ enemy: "b" }] } },
      { id: "b", ...base, pattern: "splitter", params: { children: [{ enemy: "c" }] } },
      { id: "c", ...base, pattern: "splitter", params: { children: [{ enemy: "d" }] } },
      { id: "d", ...base, pattern: "splitter", params: { children: [{ enemy: "rat" }] } },
      swarm,
    );
    expect(problems.join("\n")).toMatch(/глубже 3 ступеней/);
  });

  it("ловит делящегося без потомков, даже если данные пришли мимо типов", () => {
    // @ts-expect-error делящемуся врагу children обязателен — проверяем реакцию на данные из JSON
    const broken: EnemyDef = { id: "blob", ...base, pattern: "splitter" };
    expect(problemsOf(broken).join("\n")).toMatch(/нужен непустой children/);
  });

  it("ловит толпу потомков: за раз их не больше десяти", () => {
    const problems = problemsOf(
      { id: "blob", ...base, pattern: "splitter", params: { children: [{ enemy: "rat", count: 8 }, { enemy: "rat", count: 6 }] } },
      swarm,
    );
    expect(problems.join("\n")).toMatch(/больше 10 за раз не выпускаем/);
  });

  it("ловит параметр чужого паттерна", () => {
    // @ts-expect-error у роя нет телеграфа — проверяем реакцию на данные из JSON
    const foreign: EnemyDef = { id: "rat", ...base, pattern: "swarm", params: { telegraphSec: 1 } };
    expect(problemsOf(foreign).join("\n")).toMatch(/telegraphSec не относится к паттерну swarm/);
  });

  it("ловит неположительные время и расстояние", () => {
    const problems = problemsOf(
      { id: "wolf", ...base, pattern: "dash", params: { telegraphSec: 0 } },
      { id: "imp", ...base, pattern: "exploder", params: { blastRadius: -5 } },
    );
    expect(problems).toHaveLength(2);
  });

  it("разрешает нулевой minRadius, но требует его меньше orbitRadius", () => {
    expect(problemsOf({ id: "crow", ...base, pattern: "orbit", params: { minRadius: 0 } })).toEqual([]);
    expect(
      problemsOf({ id: "crow", ...base, pattern: "orbit", params: { orbitRadius: 50, minRadius: 50 } }).join("\n"),
    ).toMatch(/minRadius должен быть меньше orbitRadius/);
  });

  it("требует целое число потомков в разумных пределах", () => {
    for (const count of [0, 1.5, 11]) {
      const problems = problemsOf(
        { id: "blob", ...base, pattern: "splitter", params: { children: [{ enemy: "rat", count }] } },
        swarm,
      );
      expect(problems, `count ${count}`).not.toEqual([]);
    }
  });

  it("не даёт создать мир на некорректном контенте — ошибка при старте, а не нули в забеге", () => {
    const enemies: EnemyDef[] = [{ id: "wolf", ...base, pattern: "dash", params: { dashSpeed: -1 } }];
    expect(() => createWorld({ seed: 1, enemies })).toThrow(/dashSpeed/);
  });
});

describe("контент таймлайна спавна", () => {
  it("проходит проверку целиком", () => {
    // Сообщения читает геймдизайнер: пустой список — таймлайн корректен,
    // иначе в выводе написано, какой отрезок и какое поле не так.
    expect(findTimelineProblems(TIMELINE, ENDLESS_CURVE, ENEMIES)).toEqual([]);
  });

  it("расписывает руками первые минуты, а дальше передаёт кривой", () => {
    // Первую минуту видит каждый игрок, и угадывать её формулой нельзя;
    // бесконечный режим, наоборот, руками не расписать (WP4.4).
    expect(TIMELINE.length).toBeGreaterThanOrEqual(5);
    expect(ENDLESS_CURVE.fromSec).toBeGreaterThan(TIMELINE[TIMELINE.length - 1].fromSec);
  });

  it("вводит каждый тип врага до того, как он попадёт в смесь бесконечного режима", () => {
    const introduced = new Set<string>();
    for (const segment of TIMELINE) {
      for (const spawn of segment.spawns) introduced.add(spawn.enemy);
    }
    for (const id of ENDLESS_CURVE.pool) {
      expect(introduced, `враг ${id} попадает в смесь, ни разу не показавшись отдельно`).toContain(id);
    }
  });

  it("не снижает бюджет угрозы в секунду там, где огонёк заменён пешими врагами", () => {
    // Прежний огонёк стоил perSec × 3 в секунду; замена не слабее (docs/35-stage4-plan.md, Р69).
    const previous: [number, string, number][] = [
      [60, "bone_walker", 0.9],
      [120, "bone_walker", 0.75],
      [180, "mire_shambler", 1.05],
      [270, "mire_shambler", 0.9],
      [300, "bone_walker", 1.35],
    ];
    const threatOf = new Map(ENEMIES.map((enemy) => [enemy.id, enemy.threat ?? 0]));
    for (const [fromSec, enemy, budget] of previous) {
      const spawn = TIMELINE.find((segment) => segment.fromSec === fromSec)?.spawns.find((entry) => entry.enemy === enemy);
      expect(spawn, `отрезок ${fromSec}: ${enemy}`).toBeDefined();
      expect(spawn!.perSec * (threatOf.get(enemy) ?? 0), `отрезок ${fromSec}`).toBeGreaterThanOrEqual(budget - 1e-9);
    }
  });

  it("показывает могильного рыцаря событием на 240-й секунде и в бесконечном режиме, но не потоком", () => {
    const segment = TIMELINE.find((entry) => entry.fromSec === 240);
    expect(segment?.events).toContainEqual({ kind: "flank", enemy: "elite_grave_knight", count: 1 });
    expect(ENDLESS_CURVE.events).toContainEqual({ everySegments: 6, kind: "flank", enemy: "elite_grave_knight", count: 1 });
    expect(ENDLESS_CURVE.pool).not.toContain("elite_grave_knight");
  });

  it("ставит ходока на пятое место пула, а увальня — после упыря", () => {
    expect(ENDLESS_CURVE.pool[4]).toBe("bone_walker");
    expect(ENDLESS_CURVE.pool.indexOf("mire_shambler")).toBe(ENDLESS_CURVE.pool.indexOf("tank_ghoul") + 1);
  });

  it("держит элит вне обычного потока — они приходят событиями", () => {
    const elites = new Set(ENEMIES.filter((enemy) => enemy.rank !== undefined).map((enemy) => enemy.id));
    expect(elites.size).toBeGreaterThan(0);
    for (const segment of TIMELINE) {
      for (const spawn of segment.spawns) expect(elites).not.toContain(spawn.enemy);
    }
    for (const id of ENDLESS_CURVE.pool) expect(elites).not.toContain(id);
  });
});

describe("контент карт", () => {
  it("проходит проверку целиком", () => {
    expect(findMapContentProblems(MAPS)).toEqual([]);
  });

  it("содержит ровно одну карту — решение Р8 этапа 2", () => {
    expect(MAPS).toHaveLength(1);
  });
});

describe("контент оружия", () => {
  it("проходит проверку целиком", () => {
    expect(findWeaponContentProblems(WEAPONS)).toEqual([]);
  });

  it("использует только реализованные поведения", () => {
    for (const weapon of WEAPONS) {
      expect(IMPLEMENTED_WEAPON_BEHAVIORS, `оружие ${weapon.id}`).toContain(weapon.behavior);
    }
  });

  it("даёт новичку выбор из трёх оружий на первом уровне", () => {
    // Решение Р12 (docs/26-stage2-plan.md §2) — выбор перед забегом из трёх;
    // Р41 — стартовым берётся любое открытое, и первый уровень открывает три.
    expect(unlocksAt(ACCOUNT_UNLOCKS, 1).weapons.size).toBe(3);
  });

  it("содержит оружие на каждое реализованное поведение", () => {
    const used = new Set(WEAPONS.map((weapon) => weapon.behavior));
    for (const behavior of IMPLEMENTED_WEAPON_BEHAVIORS) {
      expect(used, `поведение ${behavior}`).toContain(behavior);
    }
  });
});

describe("контент пассивок и прокачки", () => {
  it("проходит проверку целиком", () => {
    expect(findPassiveContentProblems(PASSIVES)).toEqual([]);
  });

  it("в каждой категории пассивок больше, чем слотов под неё — иначе выбора нет", () => {
    for (const category of PASSIVE_CATEGORIES) {
      const inCategory = PASSIVES.filter((passive) => passive.category === category).length;
      expect(inCategory, category).toBeGreaterThan(LOADOUT_LIMITS.passives[category]);
    }
  });

  it("оружия больше, чем слотов под него", () => {
    expect(WEAPONS.length).toBeGreaterThan(LOADOUT_LIMITS.weapons);
  });

  it("даёт первый уровень в первые полминуты игры, а дальше дорожает", () => {
    // Пустая первая минута без решений — самый дешёвый способ потерять игрока.
    expect(xpForLevel(LEVEL_CURVE, 1)).toBeLessThanOrEqual(8);
    for (let level = 1; level < 20; level++) {
      expect(xpForLevel(LEVEL_CURVE, level + 1), `уровень ${level + 1}`).toBeGreaterThan(
        xpForLevel(LEVEL_CURVE, level),
      );
    }
  });
});

describe("таблица разблокировок уровня аккаунта", () => {
  const content = { weapons: WEAPONS.map((weapon) => weapon.id), passives: new Map(PASSIVES.map((passive) => [passive.id, passive.category])) };

  it("проходит проверку целиком: каждое оружие и навык открываются ровно на одном уровне, слоты не убывают", () => {
    expect(findUnlockProblems(ACCOUNT_UNLOCKS, content, LOADOUT_LIMITS)).toEqual([]);
  });

  it("на последнем уровне открыто всё, и слоты — потолок контента: golden-тесты идут на этом наборе", () => {
    const last = Math.max(...ACCOUNT_UNLOCKS.map((row) => row.level));
    const open = unlocksAt(ACCOUNT_UNLOCKS, last);
    expect(open.weapons.size).toBe(WEAPONS.length);
    expect(open.passives.size).toBe(PASSIVES.length);
    expect(open.limits).toEqual(LOADOUT_LIMITS);
    expect(unlocksAt(ACCOUNT_UNLOCKS, last + 50)).toEqual(open);
  });

  it("новичок начинает с урезанными слотами — ощущение роста (Р41)", () => {
    const first = unlocksAt(ACCOUNT_UNLOCKS, 1).limits;
    expect(first.weapons).toBeLessThan(LOADOUT_LIMITS.weapons);
  });

  it("уровень открытия знает каждое оружие и навык", () => {
    for (const weapon of WEAPONS) expect(unlockLevelOf(ACCOUNT_UNLOCKS, "weapon", weapon.id), weapon.id).not.toBeNull();
    for (const passive of PASSIVES) expect(unlockLevelOf(ACCOUNT_UNLOCKS, "passive", passive.id), passive.id).not.toBeNull();
  });

  it("стартовый набор новичка не урезан", () => {
    const first = unlocksAt(ACCOUNT_UNLOCKS, 1);
    expect([...first.weapons].sort()).toEqual(["knife", "spark", "wardstone"]);
    expect([...first.passives].sort()).toEqual(["haste", "lodestone", "mending", "might", "swiftness", "vitality"]);
    expect(first.limits).toEqual({ weapons: 2, passives: { attack: 1, defense: 1, mobility: 1 } });
  });

  it("лестница закреплена: калибровка геймдизайнера правит эти числа и таблицу вместе", () => {
    const weapons: [string, number][] = [["hearth", 2], ["storm", 4], ["sting", 11]];
    const passives: [string, number][] = [["reach", 3], ["ward", 6], ["volley", 8], ["tempering", 14]];
    for (const [id, level] of weapons) expect(unlockLevelOf(ACCOUNT_UNLOCKS, "weapon", id), id).toBe(level);
    for (const [id, level] of passives) expect(unlockLevelOf(ACCOUNT_UNLOCKS, "passive", id), id).toBe(level);
  });

  it("между открытиями не больше трёх уровней", () => {
    const levels = ACCOUNT_UNLOCKS.map((row) => row.level).sort((a, b) => a - b);
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], `уровни ${levels[i - 1]} и ${levels[i]}`).toBeLessThanOrEqual(3);
  });

  it("лестница не длиннее двадцатого уровня: дальше место под оружие поездов", () => {
    expect(Math.max(...ACCOUNT_UNLOCKS.map((row) => row.level))).toBeLessThanOrEqual(20);
  });

  it("ловит оружие без уровня, дубль, убывающие слоты и категорию, где выбирать нечего", () => {
    const problems = findUnlockProblems(
      [
        { level: 1, weapons: ["spark"], passives: ["might"], slots: { weapons: 2, passives: { attack: 1, defense: 0, mobility: 0 } } },
        { level: 2, weapons: ["spark"], slots: { weapons: 1 } },
      ],
      { weapons: ["spark", "knife"], passives: new Map([["might", "attack"]]) },
      { weapons: 2, passives: { attack: 1, defense: 0, mobility: 0 } },
    ).join("\n");
    expect(problems).toMatch(/оружие knife не открывается ни на одном уровне/);
    expect(problems).toMatch(/оружие spark открывается на уровнях 1, 2/);
    expect(problems).toMatch(/уровень 2: слотов оружия меньше, чем уровнем ниже/);
    expect(problems).toMatch(/навыков «attack» открыто 1, слотов 1 — выбирать нечего/);
  });
});

describe("проверка контента оружия", () => {
  const base = { nameKey: "n", descriptionKey: "d" };
  const ok: WeaponDef = {
    id: "spark",
    behavior: "projectile_nearest",
    ...base,
    levels: [{ damage: 5, cooldownSec: 0.3 }],
  };

  it("ловит нулевой урон и нулевую перезарядку", () => {
    const problems = findWeaponContentProblems([
      { ...ok, levels: [{ damage: 0, cooldownSec: 0 }] },
    ]);
    expect(problems).toHaveLength(2);
  });

  it("ловит дробное и нулевое число снарядов", () => {
    const problems = findWeaponContentProblems([
      { ...ok, levels: [{ damage: 5, cooldownSec: 0.3, projectiles: 0 }] },
      { ...ok, id: "other", levels: [{ damage: 5, cooldownSec: 0.3, projectiles: 1.5 }] },
    ]);
    expect(problems).toHaveLength(2);
  });

  it("ловит оружие без уровней", () => {
    expect(findWeaponContentProblems([{ ...ok, levels: [] }]).join("\n")).toMatch(
      /нет ни одного уровня/,
    );
  });

  it("ловит нереализованное поведение, даже если данные пришли мимо типов", () => {
    // @ts-expect-error поведение из JSON админки может оказаться любым — проверяем реакцию
    const broken: WeaponDef = { ...ok, behavior: "laser_beam" };
    expect(findWeaponContentProblems([broken]).join("\n")).toMatch(/не реализовано/);
  });
});

describe("контент уровней сложности", () => {
  it("проходит проверку целиком и открывает по умолчанию существующий уровень", () => {
    expect(findDifficultyContentProblems(DIFFICULTIES)).toEqual([]);
    expect(DIFFICULTIES.map((difficulty) => difficulty.id)).toContain(DEFAULT_DIFFICULTY_ID);
    expect(DIFFICULTIES.map((difficulty) => difficulty.id)).toEqual([...DIFFICULTY_IDS]);
  });

  it("ловит уровень, который по какой-то оси легче предыдущего", () => {
    const easy = DIFFICULTIES[0];
    const softer = { ...DIFFICULTIES[1], enemyHpMul: easy.enemyHpMul - 0.1 };
    expect(findDifficultyContentProblems([easy, softer])).toEqual([
      `сложность ${softer.id}: enemyHpMul меньше, чем у ${easy.id}`,
    ]);
  });

  it("ловит нулевой множитель — он обнулил бы врагов молча", () => {
    expect(findDifficultyContentProblems([{ ...DIFFICULTIES[0], spawnRateMul: 0 }])).not.toEqual([]);
  });
});

describe("контент ступеней врагов", () => {
  it("проходит проверку целиком и открывает первую ступень с нулевой секунды", () => {
    expect(findStageProblems(ENEMY_STAGES)).toEqual([]);
    expect(ENEMY_STAGES[0].fromSec).toBe(0);
  });

  it("ловит ступень, которая по какой-то оси слабее предыдущей", () => {
    const [base, hardened] = ENEMY_STAGES;
    const weaker = { ...hardened, hpMul: base.hpMul - 0.1 };
    expect(findStageProblems([base, weaker]).join("\n")).toMatch(/hpMul меньше, чем у предыдущей/);
  });

  it("ловит ступень с нулевым весом — она не пришла бы ни разу", () => {
    expect(findStageProblems([{ ...ENEMY_STAGES[0], weight: 0 }]).join("\n")).toMatch(/weight/);
  });

  it("ловит ступень, открытую не позже предыдущей", () => {
    const [base, hardened] = ENEMY_STAGES;
    expect(findStageProblems([base, { ...hardened, fromSec: 0 }]).join("\n")).toMatch(/не позже предыдущей/);
  });

  it("опыт растёт вместе со здоровьем: матёрого врага должно быть выгодно бить", () => {
    for (let i = 1; i < ENEMY_STAGES.length; i++) {
      expect(ENEMY_STAGES[i].xpMul).toBeGreaterThan(ENEMY_STAGES[i - 1].xpMul);
    }
  });
});

describe("проверка контента пассивок", () => {
  const base = { nameKey: "n", descriptionKey: "d", category: "attack" as const };

  it("не допускает нулевой и отрицательный множитель", () => {
    const defs: PassiveDef[] = [
      { id: "a", ...base, stat: "damage", op: "mul", levels: [0] },
      { id: "b", ...base, stat: "damage", op: "mul", levels: [-1] },
    ];
    expect(findPassiveContentProblems(defs)).toHaveLength(2);
  });

  it("требует целое число снарядов и только слагаемым", () => {
    const defs: PassiveDef[] = [
      { id: "a", ...base, stat: "projectiles", op: "add", levels: [1.5] },
      { id: "b", ...base, stat: "projectiles", op: "mul", levels: [2] },
    ];
    expect(findPassiveContentProblems(defs)).toHaveLength(2);
  });

  it("ловит пассивку без уровней", () => {
    const defs: PassiveDef[] = [{ id: "a", ...base, stat: "damage", op: "mul", levels: [] }];
    expect(findPassiveContentProblems(defs)).not.toEqual([]);
  });

  it("ловит опечатку в категории — контент приходит и из JSON", () => {
    const defs = [{ id: "a", ...base, category: "atack", stat: "damage", op: "mul", levels: [1.1] }];
    expect(findPassiveContentProblems(defs as unknown as PassiveDef[])).toEqual([
      "пассивка a: категория atack не из attack, defense, mobility",
    ]);
  });
});

describe("контент сундуков забега", () => {
  it("проходит проверку целиком", () => {
    expect(findChestsProblems(CHESTS)).toEqual([]);
  });

  it("ловит размер вне набора 1, 3, 5", () => {
    expect(findChestsProblems({ ...CHESTS, opening: [1, 2 as never] }).join("\n")).toContain("opening");
    expect(findChestsProblems({ ...CHESTS, sizes: [{ size: 4 as never, weight: 1 }, ...CHESTS.sizes] }).join("\n")).toContain("sizes");
  });

  it("ловит вес не больше нуля", () => {
    const sizes = CHESTS.sizes.map((entry, i) => (i === 0 ? { ...entry, weight: 0 } : entry));
    expect(findChestsProblems({ ...CHESTS, sizes }).join("\n")).toContain("weight");
  });

  it("ловит bossMinSize, которого нет среди sizes", () => {
    const sizes = CHESTS.sizes.filter((entry) => entry.size !== 5);
    expect(findChestsProblems({ ...CHESTS, sizes, bossMinSize: 5 }).join("\n")).toContain("bossMinSize");
  });

  it("ловит ownedWeightMul меньше единицы", () => {
    expect(findChestsProblems({ ...CHESTS, ownedWeightMul: 0.5 }).join("\n")).toContain("ownedWeightMul");
  });

  it("ловит lowHpRatio и xpRatio вне (0, 1]", () => {
    for (const key of ["lowHpRatio", "xpRatio"] as const) {
      for (const value of [0, -0.1, 1.2]) {
        expect(findChestsProblems({ ...CHESTS, [key]: value }).join("\n"), `${key} = ${String(value)}`).toContain(key);
      }
    }
    expect(findChestsProblems({ ...CHESTS, lowHpRatio: 1, xpRatio: 1 })).toEqual([]);
  });

  it("ловит maxOnField не целый или за потолком вида", () => {
    for (const value of [-1, 1.5, MAX_PICKUPS_OF_KIND + 1]) {
      expect(findChestsProblems({ ...CHESTS, maxOnField: value }).join("\n"), `maxOnField = ${String(value)}`).toContain(
        "maxOnField",
      );
    }
    expect(findChestsProblems({ ...CHESTS, maxOnField: 0 })).toEqual([]);
  });

  it("кладёт первое событие элиты или босса в коридор первого сундука", () => {
    const ranked = new Set(ENEMIES.filter((enemy) => enemy.rank !== undefined).map((enemy) => enemy.id));
    const first = TIMELINE.flatMap((segment) =>
      (segment.events ?? []).filter((event) => ranked.has(event.enemy)).map(() => segment.fromSec),
    ).sort((a, b) => a - b)[0];

    expect(first).toBeDefined();
    expect(first).toBeGreaterThanOrEqual(BALANCE_TARGETS.firstChestEventSec.min);
    expect(first).toBeLessThanOrEqual(BALANCE_TARGETS.firstChestEventSec.max);
  });

  it("не переполняет пул подборов суммой потолков", () => {
    const total = DROPS.medkits.maxOnField + DROPS.magnets.maxOnField + DROPS.dynamite.maxOnField + CHESTS.maxOnField;
    expect(total).toBeLessThanOrEqual(MAX_PICKUPS);
  });
});
