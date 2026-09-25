import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CONTINUE } from "../src/content/continue";
import { replayRecording } from "../src/game/diagnostics/replay";
import { applyContinue, canContinue, findContinueProblems } from "../src/game/sim/continue";
import { buildRunResult } from "../src/game/run/run-result";
import { stepWorld } from "../src/game/sim/step";
import { createWorld, damagePlayer, spawnEnemy, spawnProjectile, TICK_SEC, type World } from "../src/game/sim/world";
import { CHECKPOINT_TICKS } from "../src/game/diagnostics/run-recorder";
import { recordHeadlessRun } from "./helpers/recorded-run";
import { invulnerableAlpha } from "../src/game/render/invulnerable";

// Второй шанс — продолжение после смерти (docs/07-monetization-and-ads.md §8).
// Проверяется не «ожил», а то, где продолжение обычно ломается: добыча с
// убранных врагов, второе продолжение сверх лимита, неуязвимость, которая не
// кончается, и повтор забега, разошедшийся с оригиналом.

const RAT: EnemyDef = { id: "rat", hp: 10, speed: 1, damage: 1, xp: 1, pattern: "swarm" };

function world(rules = { perRun: 1, restoreHpRatio: 0.5, invulnerableSec: 2 }): World {
  return createWorld({ seed: 7, enemies: [RAT], continueRules: rules, config: { progressionEnabled: false } });
}

function kill(w: World): void {
  damagePlayer(w, w.player.hp + 1000, 0);
}

describe("второй шанс", () => {
  it("живому игроку продолжать нечего", () => {
    const w = world();

    expect(canContinue(w)).toBe(false);
    expect(applyContinue(w)).toBe(false);
  });

  it("убирает врагов и их снаряды без добычи, снаряды игрока оставляет", () => {
    const w = world();
    spawnEnemy(w, 0, 100, 0);
    spawnEnemy(w, 0, -100, 0);
    const hostile = spawnProjectile(w, 50, 0, -1, 0, 5, 3, false);
    const own = spawnProjectile(w, 0, 50, 0, 1, 5, 3, true);
    kill(w);

    expect(applyContinue(w)).toBe(true);

    expect(w.enemies.aliveCount).toBe(0);
    expect(w.projectiles.alive[hostile]).toBe(0);
    expect(w.projectiles.alive[own]).toBe(1);
    // Ни убийств, ни кристаллов: иначе умереть было бы выгоднее, чем выжить.
    expect(w.stats.enemiesKilled).toBe(0);
    expect(w.gems.aliveCount).toBe(0);
  });

  it("возвращает долю здоровья и снимает причину смерти", () => {
    const w = world();
    kill(w);

    applyContinue(w);

    expect(w.player.alive).toBe(true);
    expect(w.player.hp).toBe(w.playerStats.maxHp * 0.5);
    expect(w.stats.deathCauseType).toBe(-1);
  });

  it("неуязвимость держится заданные секунды и тикает вместе с миром", () => {
    const w = world();
    kill(w);
    applyContinue(w);
    const hp = w.player.hp;
    const ticks = Math.round(2 / TICK_SEC);

    damagePlayer(w, 5, 0);
    expect(w.player.hp).toBe(hp);

    for (let i = 0; i < ticks; i++) stepWorld(w, { moveX: 0, moveY: 0 });
    damagePlayer(w, 5, 0);
    expect(w.player.hp).toBeLessThan(hp);
  });

  it("не больше продолжений за забег, чем в правилах", () => {
    const w = world();
    kill(w);
    applyContinue(w);
    w.player.invulnerableTicks = 0;
    kill(w);

    expect(canContinue(w)).toBe(false);
    expect(applyContinue(w)).toBe(false);
  });

  it("секунда каждого продолжения уходит в итог забега — её сверит сервер", () => {
    const w = world({ perRun: 2, restoreHpRatio: 1, invulnerableSec: 0 });
    for (let i = 0; i < 90; i++) stepWorld(w, { moveX: 0, moveY: 0 });
    kill(w);
    applyContinue(w);

    const result = buildRunResult(w, { runId: "r", seed: 7, outcome: "died", startingWeaponId: "", contentHash: "" });

    expect(result.continues).toEqual([90 * TICK_SEC]);
  });
});

describe("числа второго шанса в контенте", () => {
  it("рабочие числа проходят проверку", () => {
    expect(findContinueProblems(CONTINUE)).toEqual([]);
  });

  it("проверка называет поле и значение", () => {
    expect(findContinueProblems({ perRun: 9, restoreHpRatio: 0, invulnerableSec: 30 })).toEqual([
      expect.stringContaining("continue.perRun"),
      expect.stringContaining("continue.restoreHpRatio"),
      expect.stringContaining("continue.invulnerableSec"),
    ]);
  });

  it("мир с некорректными числами не создаётся", () => {
    expect(() => world({ perRun: -1, restoreHpRatio: 1, invulnerableSec: 1 })).toThrow(/второй шанс/);
  });
});

describe("повтор забега со вторым шансом", () => {
  // Стоящий на месте игрок на «Сложной» гибнет быстро — дважды за один забег.
  const options = { seed: 99, maxTicks: 60 * CHECKPOINT_TICKS, difficultyId: "hard" as const, steer: () => null, continues: true };

  it("продолжение попадает в запись, и повтор совпадает с оригиналом", () => {
    const recording = recordHeadlessRun(options);

    expect(recording.outcome).toBe("died");
    expect(recording.continues).toHaveLength(CONTINUE.perRun);
    expect(recording.events.some(([, kind]) => kind === "continue")).toBe(true);
    expect(replayRecording(recording).verdict).toBe("match");
  });

  it("запись без продолжения, которое было, — расхождение, а не молчаливый пропуск", () => {
    const recording = recordHeadlessRun(options);
    const tampered = { ...recording, continues: [] };

    expect(replayRecording(tampered).verdict).toBe("mismatch");
  });

  it("запись прошлой сборки без поля повторяется как забег без второго шанса", () => {
    const legacy = recordHeadlessRun({ ...options, continues: false });
    delete legacy.continues;

    expect(replayRecording(legacy).verdict).toBe("match");
  });
});

describe("неуязвимость на экране", () => {
  it("видна пульсом, пока действует, и исчезает вместе с ней", () => {
    expect(invulnerableAlpha(0)).toBe(1);
    const alphas = Array.from({ length: 120 }, (_, tick) => invulnerableAlpha(tick + 1));
    expect(Math.min(...alphas)).toBeGreaterThanOrEqual(0.4);
    expect(Math.max(...alphas)).toBeLessThanOrEqual(1);
  });

  it("не чаще трёх пульсов в секунду: чаще — раздражитель для светочувствительных", () => {
    // Минимумы прозрачности за секунду мира — число пульсов.
    const alphas = Array.from({ length: 60 }, (_, tick) => invulnerableAlpha(tick + 1));
    const minima = alphas.filter((alpha, i) => alpha === 0.4 && alphas[i - 1] !== 0.4).length;
    expect(minima).toBeLessThanOrEqual(3);
  });
});
