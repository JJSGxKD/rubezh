import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { IMPLEMENTED_PATTERNS } from "../src/game/patterns";

// В бою нет врагов со снарядами (docs/35-stage4-plan.md, Р69, WP36; tasks/T-0172):
// давление даёт орда и кольца стражей. Критерий проверяется на исходниках, как
// `sim-purity.test.ts`: иначе он держится только на внимательности ревьюера.

/** Комментарии вырезаются: тест не должен падать на пояснениях про снаряды (как в `sim-purity.test.ts`). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*/g, " ");
}

const patternsRoot = fileURLToPath(new URL("../src/game/patterns", import.meta.url));

const REMOVED_ENEMIES = ["shooter_wisp", "boss_seer"] as const;
const REMOVED_PATTERNS = ["kite_and_shoot", "caster"] as const;
const EXPECTED_PATTERNS = ["swarm", "chase", "dash", "orbit", "exploder", "splitter", "rush", "cordon"];

describe("в бою нет врагов со снарядами", () => {
  it("паттерны врагов не создают снарядов", () => {
    for (const file of readdirSync(patternsRoot).filter((name) => name.endsWith(".ts"))) {
      const source = stripComments(readFileSync(join(patternsRoot, file), "utf8"));
      expect(source, file).not.toMatch(/\bspawnProjectile\b/);
    }
  });

  it("у врагов в контенте нет параметров стрельбы", () => {
    for (const enemy of ENEMIES) {
      const params: Readonly<Record<string, unknown>> = enemy.params ?? {};
      expect(Object.keys(params), enemy.id).not.toContain("projectileSpeed");
      expect(Object.keys(params), enemy.id).not.toContain("shotIntervalSec");
    }
  });

  it("реализованы ровно восемь паттернов, без стрельбы и кастинга", () => {
    expect([...IMPLEMENTED_PATTERNS].sort()).toEqual([...EXPECTED_PATTERNS].sort());
    for (const pattern of REMOVED_PATTERNS) expect(IMPLEMENTED_PATTERNS).not.toContain(pattern);
  });

  it("огонька и кастера нет ни в контенте, ни в таймлайне, ни в кривой", () => {
    const ids = ENEMIES.map((enemy) => enemy.id);
    for (const id of REMOVED_ENEMIES) {
      expect(ids, id).not.toContain(id);
      for (const segment of TIMELINE) {
        expect(segment.spawns.map((spawn) => spawn.enemy), `отрезок на ${segment.fromSec}s`).not.toContain(id);
        expect((segment.events ?? []).map((event) => event.enemy), `события на ${segment.fromSec}s`).not.toContain(id);
      }
      expect(ENDLESS_CURVE.pool, id).not.toContain(id);
      expect(ENDLESS_CURVE.events.map((event) => event.enemy), id).not.toContain(id);
    }
  });
});
