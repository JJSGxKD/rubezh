import { readFileSync } from "node:fs";
import { RUBEZH_AT_SEC, type EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { findRubezhProblems, RUBEZH } from "../src/content/rubezh";
import { findEnemyContentProblems } from "../src/game/patterns/enemy-types";

// Страж рубежа и его описание в контенте (T-0120, Р102/Р105): отметка одна на
// движок и сервер, страж — босс без снарядов, крепче любого другого босса.

const texts = JSON.parse(readFileSync(new URL("../../app-shell/src/i18n/ru.json", import.meta.url), "utf8")) as Record<string, string>;

const GUARD = ENEMIES.find((enemy) => enemy.id === "rubezh_guard");
const OTHER_BOSSES = ENEMIES.filter((enemy) => enemy.rank === "boss" && enemy.id !== "rubezh_guard");

/** Список врагов с подменой стража: негативы проверяют одну неисправность за раз. */
function withGuard(patch: Partial<EnemyDef> | null): EnemyDef[] {
  const rest = ENEMIES.filter((enemy) => enemy.id !== "rubezh_guard");
  return GUARD === undefined || patch === null ? rest : [...rest, { ...GUARD, ...patch } as EnemyDef];
}

describe("отметка рубежа", () => {
  it("десять минут, одна константа на контент и сервер", () => {
    expect(RUBEZH_AT_SEC).toBe(600);
    expect(RUBEZH.atSec).toBe(RUBEZH_AT_SEC);
    expect(RUBEZH.guard).toBe("rubezh_guard");
  });
});

describe("страж рубежа в контенте", () => {
  it("описан по таблице задачи: босс паттерна rush, size 2", () => {
    expect(GUARD).toMatchObject({ hp: 1400, speed: 58, damage: 24, xp: 120, threat: 300, size: 2, rank: "boss", pattern: "rush" });
  });

  it("проходит проверку контента без замечаний", () => {
    expect(findRubezhProblems(RUBEZH, ENEMIES)).toEqual([]);
    expect(findEnemyContentProblems(ENEMIES)).toEqual([]);
  });

  it("у стража нет снарядов (Р69)", () => {
    const params = (GUARD?.params ?? {}) as Record<string, unknown>;
    expect(Object.keys(params)).not.toContain("projectileSpeed");
    expect(Object.keys(params)).not.toContain("shotIntervalSec");
  });

  it("здоровье не ниже 1,3 здоровья самого крепкого из прочих боссов", () => {
    const toughest = Math.max(...OTHER_BOSSES.map((boss) => boss.hp));
    expect(OTHER_BOSSES.length).toBeGreaterThan(0);
    expect(GUARD?.hp ?? 0).toBeGreaterThanOrEqual(toughest * 1.3);
  });

  it("имя для игрока — ключ в словаре оболочки", () => {
    expect(texts["enemy.rubezh_guard.name"]).toBe("Страж рубежа");
  });

  it("стоит в массиве врагов последним: индексы прежних типов не сдвигаются", () => {
    expect(ENEMIES[ENEMIES.length - 1].id).toBe("rubezh_guard");
  });
});

describe("findRubezhProblems: негативы", () => {
  it("страж не найден", () => {
    const problems = findRubezhProblems(RUBEZH, withGuard(null));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("rubezh_guard");
  });

  it("страж не босс", () => {
    const problems = findRubezhProblems(RUBEZH, withGuard({ rank: "elite" }));
    expect(problems.some((line) => line.includes("босс"))).toBe(true);
  });

  it("стреляющий паттерн отклоняется", () => {
    for (const pattern of ["kite_and_shoot", "caster"]) {
      const problems = findRubezhProblems(RUBEZH, withGuard({ pattern: pattern as never }));
      expect(problems.some((line) => line.includes("снаряд")), pattern).toBe(true);
    }
  });

  it("параметры стрельбы отклоняются", () => {
    const problems = findRubezhProblems(RUBEZH, withGuard({ params: { projectileSpeed: 100 } as never }));
    expect(problems.some((line) => line.includes("снаряд"))).toBe(true);
  });

  it("отметка не больше нуля", () => {
    for (const atSec of [0, -10, Number.NaN]) {
      expect(findRubezhProblems({ ...RUBEZH, atSec }, ENEMIES).some((line) => line.includes("atSec"))).toBe(true);
    }
  });

  it("здоровье ниже 1,3 от прочих боссов", () => {
    const toughest = Math.max(...OTHER_BOSSES.map((boss) => boss.hp));
    const problems = findRubezhProblems(RUBEZH, withGuard({ hp: toughest * 1.29 }));
    expect(problems.some((line) => line.includes("1,3"))).toBe(true);
    expect(findRubezhProblems(RUBEZH, withGuard({ hp: toughest * 1.3 }))).toEqual([]);
  });
});
