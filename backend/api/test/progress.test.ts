import { describe, expect, it } from "vitest";
import {
  MAX_COINS_PER_RUN,
  MAX_LEVEL,
  MIN_REWARDED_SEC,
  levelForXp,
  levelReward,
  runReward,
  xpForLevel,
  type RewardableRun,
} from "../src/modules/progress/progress-rules.js";
import { progressView } from "../src/modules/progress/progress.service.js";

/**
 * Правила награды за забег и уровня (docs/35-stage4-plan.md, WP4). Числа
 * рабочие (О1, О2); проверяется не их величина, а свойства: подозрительный
 * забег награду получает, отклонённый и с читами — нет, короткий не фармится,
 * сложнее — щедрее, кривая уровня монотонна.
 */

const RUN: RewardableRun = { difficulty: "easy", survivalSec: 420, enemiesKilled: 600, level: 20, cheats: false, verdict: "ok" };

describe("награда за забег", () => {
  it("медианный забег: семь минут на лёгкой", () => {
    // 10 × 7 + 3 × 6 = 88 монет; 10 × 7 + 5 × 19 = 165 опыта
    expect(runReward(RUN)).toEqual({ coins: 88, xp: 165, skipped: null });
  });

  it("сложнее — щедрее при том же забеге", () => {
    const easy = runReward(RUN);
    const normal = runReward({ ...RUN, difficulty: "normal" });
    const hard = runReward({ ...RUN, difficulty: "hard" });
    expect(normal.coins).toBeGreaterThan(easy.coins);
    expect(hard.coins).toBeGreaterThan(normal.coins);
    expect(hard.xp).toBeGreaterThan(normal.xp);
  });

  it("подозрительный забег награду получает, отклонённый и с читами — нет", () => {
    expect(runReward({ ...RUN, verdict: "suspicious" }).skipped).toBeNull();
    expect(runReward({ ...RUN, verdict: "rejected" })).toEqual({ coins: 0, xp: 0, skipped: "rejected" });
    expect(runReward({ ...RUN, cheats: true })).toEqual({ coins: 0, xp: 0, skipped: "cheats" });
  });

  it("«нажал и вышел» не фармится, а с тридцатой секунды награда есть", () => {
    expect(runReward({ ...RUN, survivalSec: MIN_REWARDED_SEC - 1 }).skipped).toBe("too_short");
    expect(runReward({ ...RUN, survivalSec: MIN_REWARDED_SEC, enemiesKilled: 20, level: 2 }).coins).toBeGreaterThan(0);
  });

  it("сорокаминутный забег на сложной упирается в потолок забега", () => {
    expect(runReward({ ...RUN, difficulty: "hard", survivalSec: 2400, enemiesKilled: 9000 }).coins).toBe(MAX_COINS_PER_RUN);
  });
});

describe("уровень аккаунта", () => {
  it("кривая монотонна и начинается с нуля", () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(150);
    for (let level = 2; level < MAX_LEVEL; level++) expect(xpForLevel(level + 1)).toBeGreaterThan(xpForLevel(level));
  });

  it("уровень по опыту — на границах кривой", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(149)).toBe(1);
    expect(levelForXp(150)).toBe(2);
    expect(levelForXp(xpForLevel(10) - 1)).toBe(9);
    expect(levelForXp(xpForLevel(10))).toBe(10);
    expect(levelForXp(Number.MAX_SAFE_INTEGER)).toBe(MAX_LEVEL);
  });

  it("медианный игрок: десятый уровень на второй день, двадцатый — к концу недели", () => {
    const perDay = 15 * runReward(RUN).xp;
    expect(xpForLevel(10) / perDay).toBeGreaterThan(1);
    expect(xpForLevel(10) / perDay).toBeLessThan(3);
    expect(xpForLevel(20) / perDay).toBeGreaterThan(5);
    expect(xpForLevel(20) / perDay).toBeLessThan(9);
  });

  it("самоцветы за уровень — раз в пять уровней", () => {
    expect(levelReward(4)).toEqual({ coins: 200, gems: 0 });
    expect(levelReward(5)).toEqual({ coins: 250, gems: 10 });
  });

  it("вид прогресса: сколько внутри уровня и до следующего", () => {
    expect(progressView({ xp: 200, level: 2 })).toEqual({ level: 2, xp: 200, xpIntoLevel: 50, xpForNext: xpForLevel(3) - 150, nextReward: { coins: 150, gems: 0 } });
    expect(progressView({ xp: xpForLevel(MAX_LEVEL), level: MAX_LEVEL })).toMatchObject({ xpForNext: null, nextReward: null });
  });
});
