import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { createProjectilePool } from "../src/game/sim/pools";
import { createWorld, spawnProjectile, TICK_SEC } from "../src/game/sim/world";
import { stepWorld } from "../src/game/sim/step";
import { CHESTS } from "../src/content/chests";
import { DROPS } from "../src/content/drops";
import { MAPS } from "../src/content/maps";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
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

  it("в пуле снарядов нет понятия вражеского", () => {
    const pool: object = createProjectilePool(4);
    expect(pool).not.toHaveProperty("fromPlayer");
    expect(pool).not.toHaveProperty("ownerType");
    expect(spawnProjectile.length).toBe(7);
  });

  it("шаг не бьёт игрока снарядом: снаряд в упор исчезает по сроку жизни", () => {
    const world = createWorld({
      seed: 1,
      enemies: ENEMIES,
      weapons: WEAPONS,
      passives: PASSIVES,
      levelCurve: LEVEL_CURVE,
      loadoutLimits: LOADOUT_LIMITS,
      drops: DROPS,
      chests: CHESTS,
      map: MAPS[0],
    });
    const hp = world.player.hp;
    spawnProjectile(world, world.player.x, world.player.y, 0, 0, 5, 20 * TICK_SEC);
    for (let i = 0; i < 30; i++) stepWorld(world, { moveX: 0, moveY: 0 });
    expect(world.stats.damageTaken).toBe(0);
    expect(world.player.hp).toBe(hp);
    expect(world.projectiles.aliveCount).toBe(0);
  });

  it("в исходниках нет вражеских снарядов", () => {
    const roots = [
      fileURLToPath(new URL("../src/game", import.meta.url)),
      fileURLToPath(new URL("../src/run-api.ts", import.meta.url)),
      fileURLToPath(new URL("../../app-shell/src", import.meta.url)),
    ];
    const files: string[] = [];
    const walk = (path: string): void => {
      if (statSync(path).isDirectory()) {
        for (const name of readdirSync(path)) walk(join(path, name));
      } else if (/\.tsx?$/.test(path)) {
        files.push(path);
      }
    };
    for (const root of roots) walk(root);
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      expect(source, file).not.toMatch(/(enemyShots|enemyProjectile|enemyProjectileCore|fromPlayer|enemyCooldown)/);
      expect(source, file).not.toContain("projectile-enemy");
    }
    const looks = stripComments(readFileSync(fileURLToPath(new URL("../src/game/render/looks.ts", import.meta.url)), "utf8"));
    expect(looks).not.toContain('"bolt"');
  });
});
