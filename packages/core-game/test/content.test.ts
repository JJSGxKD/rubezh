import type { EnemyDef, PassiveDef, WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { WAVES } from "../src/content/waves";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { findEnemyContentProblems, IMPLEMENTED_PATTERNS } from "../src/game/patterns";
import { findPassiveContentProblems } from "../src/game/progression/passives";
import { xpForLevel } from "../src/game/progression/levels";
import { findWeaponContentProblems, IMPLEMENTED_WEAPON_BEHAVIORS } from "../src/game/weapons";
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
});

describe("проверка параметров паттернов", () => {
  const base = { hp: 10, speed: 50, damage: 1, xp: 1 };
  const swarm: EnemyDef = { id: "rat", ...base, pattern: "swarm" };

  function problemsOf(...defs: EnemyDef[]): string[] {
    return findEnemyContentProblems(defs);
  }

  it("ловит делящегося, который ссылается на несуществующего врага", () => {
    const problems = problemsOf({ id: "blob", ...base, pattern: "splitter", params: { childEnemy: "ghost" } });
    expect(problems.join("\n")).toMatch(/childEnemy ghost не найден/);
  });

  it("не даёт делящемуся распадаться на делящихся", () => {
    const problems = problemsOf(
      { id: "a", ...base, pattern: "splitter", params: { childEnemy: "b" } },
      { id: "b", ...base, pattern: "splitter", params: { childEnemy: "rat" } },
      swarm,
    );
    expect(problems.join("\n")).toMatch(/не может быть делящимся/);
  });

  it("ловит делящегося без childEnemy, даже если данные пришли мимо типов", () => {
    // @ts-expect-error делящемуся врагу childEnemy обязателен — проверяем реакцию на данные из JSON
    const broken: EnemyDef = { id: "blob", ...base, pattern: "splitter" };
    expect(problemsOf(broken).join("\n")).toMatch(/нужен childEnemy/);
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
    for (const childCount of [0, 1.5, 9]) {
      const problems = problemsOf(
        { id: "blob", ...base, pattern: "splitter", params: { childEnemy: "rat", childCount } },
        swarm,
      );
      expect(problems, `childCount ${childCount}`).not.toEqual([]);
    }
  });

  it("не даёт создать мир на некорректном контенте — ошибка при старте, а не нули в забеге", () => {
    const enemies: EnemyDef[] = [{ id: "wolf", ...base, pattern: "dash", params: { dashSpeed: -1 } }];
    expect(() => createWorld({ seed: 1, enemies })).toThrow(/dashSpeed/);
  });
});

describe("контент волн", () => {
  it("ссылается только на существующих врагов", () => {
    const known = new Set(ENEMIES.map((enemy) => enemy.id));
    for (const wave of WAVES) {
      for (const spawn of wave.spawns) {
        expect(known, `волна на ${wave.second}s`).toContain(spawn.enemy);
      }
    }
  });

  it("не содержит пустых волн и спавнов нулевого размера", () => {
    for (const wave of WAVES) {
      expect(wave.spawns.length, `волна на ${wave.second}s`).toBeGreaterThan(0);
      for (const spawn of wave.spawns) {
        expect(spawn.count, `спавн ${spawn.enemy}`).toBeGreaterThan(0);
      }
    }
  });

  it("идёт по строго возрастающей секунде", () => {
    for (let i = 1; i < WAVES.length; i++) {
      expect(WAVES[i].second).toBeGreaterThan(WAVES[i - 1].second);
    }
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

  it("даёт игроку выбор из трёх стартовых оружий", () => {
    // Решение Р12 (docs/26-stage2-plan.md §2): выбор перед забегом из трёх.
    expect(WEAPONS.filter((weapon) => weapon.starting === true)).toHaveLength(3);
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

  it("предлагает больше пассивок, чем помещается в слоты — иначе выбора нет", () => {
    expect(PASSIVES.length).toBeGreaterThan(LOADOUT_LIMITS.passives);
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

describe("проверка контента оружия", () => {
  const base = { nameKey: "n", descriptionKey: "d" };
  const ok: WeaponDef = {
    id: "spark",
    behavior: "projectile_nearest",
    ...base,
    starting: true,
    levels: [{ damage: 5, cooldownSec: 0.3 }],
  };

  it("требует хотя бы одно стартовое оружие", () => {
    const problems = findWeaponContentProblems([{ ...ok, starting: false }]);
    expect(problems.join("\n")).toMatch(/нет ни одного стартового оружия/);
  });

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

describe("проверка контента пассивок", () => {
  const base = { nameKey: "n", descriptionKey: "d" };

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
});
