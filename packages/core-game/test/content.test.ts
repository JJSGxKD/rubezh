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
import { BASE_WEAPONS, WEAPONS } from "../src/content/weapons";
import { findEnemyContentProblems, IMPLEMENTED_PATTERNS, PATTERN_TRAITS } from "../src/game/patterns";
import { findChestsProblems } from "../src/game/sim/chests";
import { findMapContentProblems } from "../src/game/sim/map-types";
import { MAX_PICKUPS, MAX_PICKUPS_OF_KIND } from "../src/game/sim/pickups";
import { findTimelineProblems } from "../src/game/sim/timeline-content";
import { findPassiveContentProblems } from "../src/game/progression/passives";
import { xpForLevel } from "../src/game/progression/levels";
import { findUnlockProblems, unlockLevelOf, unlocksAt } from "../src/game/progression/unlocks";
import { findWeaponContentProblems, IMPLEMENTED_WEAPON_BEHAVIORS } from "../src/game/weapons";
import { DEFAULT_SIM_CONFIG } from "../src/game/sim/create-world";
import { createWorld } from "../src/game/sim/world";

// Дешёвые тесты, ловящие опечатки в контенте за миллисекунды
// (docs/17-testing-strategy.md §3.1). Геймдизайнер узнаёт об ошибке из CI
// через минуту, а не из ручного плейтеста через день.

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

  it("содержит врага на каждом реализованном паттерне", () => {
    const used = new Set(ENEMIES.map((enemy) => enemy.pattern));
    for (const pattern of IMPLEMENTED_PATTERNS) {
      expect(used, `паттерн ${pattern}`).toContain(pattern);
    }
  });

  it("описывает пеших врагов по таблице задачи", () => {
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

  it("не оставляет блуждающего огонька ни во врагах, ни в отрезках, ни в пуле", () => {
    expect(ENEMIES.map((enemy) => enemy.id)).not.toContain("shooter_wisp");
    const fromSecs = TIMELINE.filter((segment) => segment.spawns.some((spawn) => spawn.enemy === "shooter_wisp")).map((segment) => segment.fromSec);
    expect(fromSecs).toEqual([]);
    expect(ENDLESS_CURVE.pool).not.toContain("shooter_wisp");
  });

  it("не даёт опыта меньше за более крепкого рядового", () => {
    const xpOf = (id: string) => ENEMIES.find((enemy) => enemy.id === id)!.xp;
    expect(xpOf("mire_shambler")).toBeGreaterThan(xpOf("bone_walker"));
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

  it("показывает пеших врагов в расписанных отрезках с числами задачи", () => {
    const perSec = (fromSec: number, enemy: string) =>
      TIMELINE.find((segment) => segment.fromSec === fromSec)?.spawns.find((spawn) => spawn.enemy === enemy);
    expect(perSec(60, "bone_walker")).toMatchObject({ perSec: 0.5, burst: 4 });
    expect(perSec(120, "bone_walker")).toMatchObject({ perSec: 0.4 });
    expect(perSec(180, "mire_shambler")).toMatchObject({ perSec: 0.22, burst: 2 });
    expect(perSec(270, "mire_shambler")).toMatchObject({ perSec: 0.2 });
    expect(perSec(300, "bone_walker")).toMatchObject({ perSec: 0.7 });
  });

  it("показывает могильного рыцаря событием на 240-й секунде и в бесконечном режиме, но не потоком", () => {
    const segment = TIMELINE.find((entry) => entry.fromSec === 240);
    expect(segment?.events).toContainEqual({ kind: "flank", enemy: "elite_grave_knight", count: 1 });
    expect(ENDLESS_CURVE.events).toContainEqual({ everySegments: 6, kind: "flank", enemy: "elite_grave_knight", count: 1 });
    expect(ENDLESS_CURVE.pool).not.toContain("elite_grave_knight");
  });

  it("ставит новых рядовых в конец пула, не сдвигая прежних", () => {
    const pool = ENDLESS_CURVE.pool;
    expect(pool.indexOf("bone_walker")).toBe(pool.indexOf("tank_ghoul") + 1);
    expect(pool.indexOf("mire_shambler")).toBe(pool.indexOf("tank_ghoul") + 2);
    // Прежние типы идут в прежнем порядке — без огонька, который стоял пятым.
    expect(pool).toEqual([
      "swarm_rat",
      "circler_crow",
      "rushing_bats",
      "dasher_wolf",
      "bomber_imp",
      "splitter_slime",
      "tank_ghoul",
      "bone_walker",
      "mire_shambler",
    ]);
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

describe("контент стража кольца и колец в таймлайне", () => {
  const guard = ENEMIES.find((enemy) => enemy.id === "cordon_guard");

  /** Кольцо расписания: секунда, число стражей и параметры строя. */
  interface RingAt {
    sec: number;
    count: number;
    lifeSec: number;
    radius: number;
  }

  /** Кольца по ходу забега: расписанные руками и первые срабатывания события кривой. */
  function ringsInOrder(curveFirings: number): RingAt[] {
    const rings: RingAt[] = [];
    for (const segment of TIMELINE) {
      for (const event of segment.events ?? []) {
        if (event.kind === "cordon" && event.ring !== undefined) {
          rings.push({ sec: segment.fromSec, count: event.count, lifeSec: event.ring.lifeSec, radius: event.ring.radius });
        }
      }
    }
    const curveEvent = ENDLESS_CURVE.events.find((event) => event.kind === "cordon");
    if (curveEvent?.ring === undefined) return rings;
    // Событие кривой срабатывает на отрезках с (шаг + 1) % everySegments === 0 (sim/timeline.ts).
    let fired = 0;
    for (let step = 0; fired < curveFirings; step++) {
      if ((step + 1) % curveEvent.everySegments !== 0) continue;
      rings.push({
        sec: ENDLESS_CURVE.fromSec + step * ENDLESS_CURVE.segmentSec,
        count: curveEvent.count,
        lifeSec: curveEvent.ring.lifeSec,
        radius: curveEvent.ring.radius,
      });
      fired++;
    }
    return rings;
  }

  it("заводит стража с паттерном cordon: крепкий, медленный, без ранга, стихии и стойкости", () => {
    expect(guard).toBeDefined();
    expect(guard?.pattern).toBe("cordon");
    expect(guard?.rank).toBeUndefined();
    expect(guard?.hp).toBeGreaterThanOrEqual(60);
    expect(guard?.speed).toBeLessThanOrEqual(40);
    expect(guard?.element).toBeUndefined();
    expect(guard?.resist).toBeUndefined();
  });

  it("проходит проверку таймлайна целиком", () => {
    expect(findTimelineProblems(TIMELINE, ENDLESS_CURVE, ENEMIES)).toEqual([]);
  });

  it("ставит первое кольцо на 180-ю секунду, второе на 300-ю, а воронье окружение не трогает", () => {
    const early = TIMELINE.filter((segment) => segment.fromSec < 180);
    for (const segment of early) {
      expect((segment.events ?? []).map((event) => event.kind), `отрезок на ${segment.fromSec}s`).not.toContain("cordon");
    }
    const events = (fromSec: number) => TIMELINE.find((segment) => segment.fromSec === fromSec)?.events ?? [];
    expect(events(180).filter((event) => event.kind === "cordon")).toHaveLength(1);
    expect(events(300).filter((event) => event.kind === "cordon")).toHaveLength(1);
    expect(events(180)).toContainEqual({ kind: "ring", enemy: "circler_crow", count: 16 });
    expect(ENDLESS_CURVE.events.find((event) => event.kind === "cordon")?.everySegments).toBe(3);
  });

  it("замыкает каждое кольцо: просвет между соседними стражами уже диаметра игрока", () => {
    const guardRadius = PATTERN_TRAITS.cordon.radius;
    const playerRadius = DEFAULT_SIM_CONFIG.player.radius;
    for (const ring of ringsInOrder(10)) {
      const gap = (2 * Math.PI * ring.radius) / ring.count - 2 * guardRadius;
      expect(gap, `кольцо на ${ring.sec}s`).toBeLessThan(2 * playerRadius);
    }
  });

  it("не ослабляет кольца по ходу забега: стражей и времени не меньше, чем в предыдущем", () => {
    const rings = ringsInOrder(10);
    for (let i = 1; i < rings.length; i++) {
      expect(rings[i].count, `стражей в кольце на ${rings[i].sec}s`).toBeGreaterThanOrEqual(rings[i - 1].count);
      expect(rings[i].lifeSec, `lifeSec кольца на ${rings[i].sec}s`).toBeGreaterThanOrEqual(rings[i - 1].lifeSec);
    }
  });

  it("не накладывает кольца: между соседними не меньше lifeSec предыдущего и ещё десяти секунд", () => {
    const rings = ringsInOrder(10);
    expect(rings.length).toBeGreaterThanOrEqual(12);
    for (let i = 1; i < rings.length; i++) {
      expect(rings[i].sec - rings[i - 1].sec, `кольцо на ${rings[i].sec}s`).toBeGreaterThanOrEqual(rings[i - 1].lifeSec + 10);
    }
  });

  it("не пускает стража ни в обычный поток, ни в пул кривой", () => {
    for (const segment of TIMELINE) {
      for (const spawn of segment.spawns) expect(spawn.enemy, `отрезок на ${segment.fromSec}s`).not.toBe("cordon_guard");
    }
    expect(ENDLESS_CURVE.pool).not.toContain("cordon_guard");
  });
});

describe("боссы бесконечного режима", () => {
  it("в кривой один вид босса — Матрёшка, два ритма: раз в пять отрезков и раз в восемь", () => {
    const bosses = new Set(ENEMIES.filter((enemy) => enemy.rank === "boss").map((enemy) => enemy.id));
    const onCurve = ENDLESS_CURVE.events.filter((event) => bosses.has(event.enemy));
    expect(onCurve).toEqual([
      { everySegments: 5, kind: "ring", enemy: "boss_matryoshka", count: 1 },
      { everySegments: 8, kind: "ring", enemy: "boss_matryoshka", count: 1 },
    ]);
  });

  it("смесь и стартовый набор кривой помещаются в пул из девяти врагов", () => {
    expect(ENDLESS_CURVE.pool).toHaveLength(9);
    expect(ENDLESS_CURVE.startTypes).toBeLessThanOrEqual(ENDLESS_CURVE.pool.length);
    expect(ENDLESS_CURVE.mixSize).toBeLessThanOrEqual(ENDLESS_CURVE.pool.length);
    expect(findTimelineProblems(TIMELINE, ENDLESS_CURVE, ENEMIES)).toEqual([]);
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
  const content = { weapons: BASE_WEAPONS.map((weapon) => weapon.id), passives: new Map(PASSIVES.map((passive) => [passive.id, passive.category])) };

  it("проходит проверку целиком: каждое оружие и навык открываются ровно на одном уровне, слоты не убывают", () => {
    expect(findUnlockProblems(ACCOUNT_UNLOCKS, content, LOADOUT_LIMITS)).toEqual([]);
  });

  it("на последнем уровне открыто всё, и слоты — потолок контента: golden-тесты идут на этом наборе", () => {
    const last = Math.max(...ACCOUNT_UNLOCKS.map((row) => row.level));
    const open = unlocksAt(ACCOUNT_UNLOCKS, last);
    expect(open.weapons.size).toBe(BASE_WEAPONS.length);
    expect(open.passives.size).toBe(PASSIVES.length);
    expect(open.limits).toEqual(LOADOUT_LIMITS);
    expect(unlocksAt(ACCOUNT_UNLOCKS, last + 50)).toEqual(open);
  });

  it("новичок начинает с урезанными слотами — ощущение роста (Р41)", () => {
    const first = unlocksAt(ACCOUNT_UNLOCKS, 1).limits;
    expect(first.weapons).toBeLessThan(LOADOUT_LIMITS.weapons);
  });

  it("уровень открытия знает каждое оружие и навык", () => {
    for (const weapon of BASE_WEAPONS) expect(unlockLevelOf(ACCOUNT_UNLOCKS, "weapon", weapon.id), weapon.id).not.toBeNull();
    for (const passive of PASSIVES) expect(unlockLevelOf(ACCOUNT_UNLOCKS, "passive", passive.id), passive.id).not.toBeNull();
  });

  it("стартовый набор новичка не урезан", () => {
    const first = unlocksAt(ACCOUNT_UNLOCKS, 1);
    expect([...first.weapons].sort()).toEqual(["knife", "spark", "wardstone"]);
    expect([...first.passives].sort()).toEqual(["haste", "lodestone", "mending", "might", "swiftness", "vitality"]);
    expect(first.limits).toEqual({ weapons: 2, passives: { attack: 1, defense: 1, mobility: 1 } });
  });

  it("лестница закреплена: калибровка геймдизайнера правит эти числа и таблицу вместе", () => {
    const weapons: [string, number][] = [["hearth", 2], ["storm", 4], ["sting", 11], ["meteor", 16]];
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
  /** Множители «Сложной» до T-0192: новая единая сложность обязана быть строго тяжелее по каждой оси. */
  const PREVIOUS_HARD = { enemyHpMul: 1.8, enemyDamageMul: 1.5, spawnRateMul: 1.35, maxAliveMul: 1.3 };
  const hard = DIFFICULTIES.find((difficulty) => difficulty.id === "hard");

  it("проходит проверку целиком и открывает по умолчанию существующий уровень", () => {
    expect(findDifficultyContentProblems(DIFFICULTIES)).toEqual([]);
    expect(DIFFICULTIES.map((difficulty) => difficulty.id)).toContain(DEFAULT_DIFFICULTY_ID);
    expect(DIFFICULTIES.map((difficulty) => difficulty.id)).toEqual([...DIFFICULTY_IDS]);
  });

  it("единая сложность тяжелее прежней «Сложной» по каждой оси и не выше пределов", () => {
    expect(hard).toBeDefined();
    if (hard === undefined) return;
    expect(hard.enemyHpMul).toBeGreaterThan(PREVIOUS_HARD.enemyHpMul);
    expect(hard.enemyDamageMul).toBeGreaterThan(PREVIOUS_HARD.enemyDamageMul);
    expect(hard.spawnRateMul).toBeGreaterThan(PREVIOUS_HARD.spawnRateMul);
    expect(hard.maxAliveMul).toBeGreaterThan(PREVIOUS_HARD.maxAliveMul);
    expect(hard.enemyHpMul).toBeLessThanOrEqual(2.5);
    expect(hard.enemyDamageMul).toBeLessThanOrEqual(2.1);
    expect(hard.spawnRateMul).toBeLessThanOrEqual(1.8);
    expect(hard.maxAliveMul).toBeLessThanOrEqual(BALANCE_TARGETS.latePressure.hardMaxAliveMulMax);
    // Живых врагов не больше слотов пула: выше растёт нагрузка на телефон, а не сложность.
    expect(ENDLESS_CURVE.maxAlive * hard.maxAliveMul).toBeLessThanOrEqual(360);
  });

  it("обучающая и нормальная без изменений", () => {
    const find = (id: string) => DIFFICULTIES.find((difficulty) => difficulty.id === id);
    expect(find("easy")).toMatchObject({ enemyHpMul: 1, enemyDamageMul: 1, spawnRateMul: 1, maxAliveMul: 1 });
    expect(find("normal")).toMatchObject({ enemyHpMul: 1.3, enemyDamageMul: 1.2, spawnRateMul: 1.15, maxAliveMul: 1.1 });
  });

  it("запасной уровень — единая сложность", () => {
    expect(DEFAULT_DIFFICULTY_ID).toBe("hard");
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

describe("шесть ступеней врагов: траектория роста после 5:30", () => {
  it("открываются на 0, 150, 330, 480, 660 и 840 секундах", () => {
    expect(ENEMY_STAGES.map((stage) => stage.fromSec)).toEqual([0, 150, 330, 480, 660, 840]);
    expect(findStageProblems(ENEMY_STAGES)).toEqual([]);
  });

  it("называет каждую ступень со второй, ключи не повторяются", () => {
    const keys = ENEMY_STAGES.slice(1).map((stage) => stage.nameKey);
    expect(keys.every((key) => typeof key === "string" && key.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // Прежние «Закалённый» (0,55) и «Лютый» (0,5) не меняются, поэтому рост веса
  // проверяется от «Лютого»: каждая из трёх новых тяжелее предыдущей.
  it("вес растёт от «Лютого»: новая ступень занимает заметную долю потока", () => {
    for (let i = 3; i < ENEMY_STAGES.length; i++) {
      expect(ENEMY_STAGES[i].weight, `ступень ${i}`).toBeGreaterThan(ENEMY_STAGES[i - 1].weight);
    }
  });

  it("не разгоняет врага быстрее 1,25 от базовой скорости", () => {
    for (const stage of ENEMY_STAGES) expect(stage.speedMul).toBeLessThanOrEqual(1.25);
  });

  it("опыт растёт быстрее здоровья: xpMul / hpMul не убывает", () => {
    for (let i = 2; i < ENEMY_STAGES.length; i++) {
      const before = ENEMY_STAGES[i - 1].xpMul / ENEMY_STAGES[i - 1].hpMul;
      const after = ENEMY_STAGES[i].xpMul / ENEMY_STAGES[i].hpMul;
      expect(after, `ступень ${i}`).toBeGreaterThanOrEqual(before);
    }
  });
});

describe("давление после 8-й минуты (Р128)", () => {
  const latePressure = BALANCE_TARGETS.latePressure;
  const hard = DIFFICULTIES.find((difficulty) => difficulty.id === "hard");

  /** Степень умножением в цикле: как в симуляции, без `Math.pow`. */
  function growth(base: number, steps: number): number {
    let value = 1;
    for (let i = 0; i < steps; i++) value *= base;
    return value;
  }

  /**
   * Индекс силы врага на секунде `sec`: здоровье × урон «Сложной» и кривой,
   * умноженные на средневзвешенный `hpMul × damageMul` открытых ступеней.
   */
  function strengthAt(sec: number): number {
    if (hard === undefined) throw new Error("в контенте нет «Сложной»");
    const step = Math.floor((sec - ENDLESS_CURVE.fromSec) / ENDLESS_CURVE.segmentSec);
    const hp = hard.enemyHpMul * growth(ENDLESS_CURVE.hpGrowth, step);
    const damage = hard.enemyDamageMul * growth(ENDLESS_CURVE.damageGrowth, step);
    let weight = 0;
    let weighted = 0;
    for (const stage of ENEMY_STAGES) {
      if (stage.fromSec > sec) break;
      weight += stage.weight;
      weighted += stage.weight * stage.hpMul * stage.damageMul;
    }
    return (hp * damage * weighted) / weight;
  }

  const rankedIds = new Set(ENEMIES.filter((enemy) => enemy.rank !== undefined).map((enemy) => enemy.id));
  const bossIds = new Set(ENEMIES.filter((enemy) => enemy.rank === "boss").map((enemy) => enemy.id));

  interface RankEvent {
    sec: number;
    step: number | null;
    boss: boolean;
  }

  /** События элит и боссов в окне `[from, to)`: расписанные руками и кривой. */
  function rankEvents(from: number, to: number): RankEvent[] {
    const events: RankEvent[] = [];
    for (const segment of TIMELINE) {
      for (const event of segment.events ?? []) {
        if (rankedIds.has(event.enemy) && segment.fromSec >= from && segment.fromSec < to) {
          events.push({ sec: segment.fromSec, step: null, boss: bossIds.has(event.enemy) });
        }
      }
    }
    const lastStep = Math.ceil((to - ENDLESS_CURVE.fromSec) / ENDLESS_CURVE.segmentSec);
    for (let step = 0; step <= lastStep; step++) {
      const sec = ENDLESS_CURVE.fromSec + step * ENDLESS_CURVE.segmentSec;
      if (sec < from || sec >= to) continue;
      for (const event of ENDLESS_CURVE.events) {
        if (rankedIds.has(event.enemy) && (step + 1) % event.everySegments === 0) {
          events.push({ sec, step, boss: bossIds.has(event.enemy) });
        }
      }
    }
    return events;
  }

  it("индекс силы врага растёт за три минуты в коридоре на точках 8:00, 11:00, 14:00, 17:00", () => {
    const points = [480, 660, 840, 1020].map(strengthAt);
    for (let i = 1; i < points.length; i++) {
      const ratio = points[i] / points[i - 1];
      expect(ratio, `${i}-е отношение`).toBeGreaterThanOrEqual(latePressure.strengthGrowthPer3Min.min);
      expect(ratio, `${i}-е отношение`).toBeLessThanOrEqual(latePressure.strengthGrowthPer3Min.max);
    }
  });

  it("после 8-й минуты элиты и боссы приходят не реже 0,9 в минуту и вдвое плотнее, чем до неё", () => {
    const window = (latePressure.toSec - latePressure.fromSec) / 60;
    const late = rankEvents(latePressure.fromSec, latePressure.toSec);
    const early = rankEvents(0, latePressure.fromSec);
    expect(late.length / window).toBeGreaterThanOrEqual(latePressure.rankEventsPerMinuteMin);
    expect(late.length / window / (early.length / (latePressure.fromSec / 60))).toBeGreaterThanOrEqual(
      latePressure.rankEventsDensityRatioMin,
    );
    expect(late.length).toBeGreaterThanOrEqual(12);
    expect(late.filter((event) => event.boss).length).toBeGreaterThanOrEqual(4);
  });

  it("не складывает события в кучу: на одном отрезке не больше одного босса и двух событий", () => {
    const late = rankEvents(latePressure.fromSec, latePressure.toSec);
    const bySec = new Map<number, RankEvent[]>();
    for (const event of late) bySec.set(event.sec, [...(bySec.get(event.sec) ?? []), event]);
    for (const [sec, events] of bySec) {
      expect(events.length, `секунда ${sec}`).toBeLessThanOrEqual(2);
      expect(events.filter((event) => event.boss).length, `секунда ${sec}`).toBeLessThanOrEqual(1);
    }
  });

  it("кривая только круче прежней и не выходит за пределы", () => {
    expect(ENDLESS_CURVE.threatGrowth).toBeGreaterThan(1.18);
    expect(ENDLESS_CURVE.hpGrowth).toBeGreaterThan(1.12);
    expect(ENDLESS_CURVE.damageGrowth).toBeGreaterThan(1.06);
    expect(ENDLESS_CURVE.threatGrowth).toBeLessThanOrEqual(1.24);
    expect(ENDLESS_CURVE.hpGrowth).toBeLessThanOrEqual(1.16);
    expect(ENDLESS_CURVE.damageGrowth).toBeLessThanOrEqual(1.1);
    expect(findTimelineProblems(TIMELINE, ENDLESS_CURVE, ENEMIES)).toEqual([]);
  });

  it("не трогает рубеж 10:00: Матрёшка на 9:30 на месте, новых боссов ближе минуты к нему нет", () => {
    const bosses = rankEvents(0, 1500).filter((event) => event.boss);
    expect(bosses.some((event) => event.sec === 570)).toBe(true);
    for (const event of bosses) {
      if (event.sec === 570) continue;
      expect(Math.abs(event.sec - 600), `босс на ${event.sec} с`).toBeGreaterThan(60);
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
