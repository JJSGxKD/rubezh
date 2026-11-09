import { describe, expect, it } from "vitest";
import { BOOSTS } from "../src/content/boosts";
import { MAPS } from "../src/content/maps";
import { PRESSURE } from "../src/content/pressure";
import { ACCOUNT_UNLOCKS } from "../src/content/unlocks";
import { POWER_PROFILES, simulateBalanceRun, withDevice, type PowerProfile } from "../src/game/balance";
import { sanitizeLoadout } from "../src/game/progression/run-loadout";
import { createRunWorld } from "../src/game/run-world";
import { TICK_SEC, type World } from "../src/game/sim/world";

// Профили силы калибровки подстройки (tasks/T-0196, решение 1, Р131, Р183):
// три игрока на реальном контенте. Числа профилей сверяет с каталогом предметов
// отдельный тест на сервере (scripts/test/power-profiles.test.ts).

const TOP_LEVEL = Math.max(...ACCOUNT_UNLOCKS.map((row) => row.level));

function worldOf(profile: PowerProfile, elapsedSec = 0): { world: World; update(): void } {
  const { world, spawner } = createRunWorld({
    seed: 1,
    mapId: MAPS[0].id,
    difficultyId: "hard",
    unitScale: 1,
    loadout: profile.loadout,
  });
  world.stats.elapsedSec = elapsedSec;
  return { world, update: () => spawner.update(world, TICK_SEC) };
}

describe("профили силы", () => {
  it("новичок — первый уровень аккаунта без снаряжения и бустов", () => {
    expect(POWER_PROFILES.novice.loadout).toEqual({ modifiers: {}, boosts: [], accountLevel: 1 });
  });

  it("средний — восьмой уровень, полный арсенал — верхняя строка лестницы открытий", () => {
    expect(POWER_PROFILES.average.loadout.accountLevel).toBe(8);
    expect(POWER_PROFILES.full.loadout.accountLevel).toBe(TOP_LEVEL);
  });

  it("у полного арсенала три буста, и все они есть в каталоге бустов", () => {
    expect(POWER_PROFILES.full.loadout.boosts).toEqual(["fury", "bulwark", "aegis"]);
    const known = new Set(BOOSTS.map((boost) => boost.id));
    for (const id of POWER_PROFILES.full.loadout.boosts) expect(known.has(id), id).toBe(true);
    expect(POWER_PROFILES.average.loadout.boosts).toEqual([]);
  });

  it("пределы движка ничего не срезают: набор профиля доходит до мира целым", () => {
    for (const profile of Object.values(POWER_PROFILES)) {
      expect(sanitizeLoadout(profile.loadout), profile.id).toEqual(profile.loadout);
    }
  });

  it("слабое устройство меняет только класс устройства", () => {
    for (const profile of Object.values(POWER_PROFILES)) {
      const light = withDevice(profile, "light");
      expect(light.loadout).toEqual({ ...profile.loadout, deviceClass: "light" });
      expect(light.id).toBe(profile.id);
      expect(profile.loadout.deviceClass).toBeUndefined();
    }
  });
});

describe("подстройка на профилях реального контента", () => {
  const level = (profile: PowerProfile): number => worldOf(profile).world.difficulty.pressureLevel;

  it("уровни давления лежат в своих коридорах", () => {
    expect(level(POWER_PROFILES.novice)).toBeGreaterThanOrEqual(0.76);
    expect(level(POWER_PROFILES.novice)).toBeLessThanOrEqual(0.85);
    expect(level(POWER_PROFILES.average)).toBeGreaterThanOrEqual(0.9);
    expect(level(POWER_PROFILES.average)).toBeLessThanOrEqual(1.1);
    expect(level(POWER_PROFILES.full)).toBeGreaterThanOrEqual(1.2);
    expect(level(POWER_PROFILES.full)).toBeLessThanOrEqual(1.3);
  });

  it("порядок строгий: новичок < средний < полный, очки растут так же", () => {
    expect(level(POWER_PROFILES.novice)).toBeLessThan(level(POWER_PROFILES.average));
    expect(level(POWER_PROFILES.average)).toBeLessThan(level(POWER_PROFILES.full));
    const power = (profile: PowerProfile): number => worldOf(profile).world.difficulty.startPower;
    expect(power(POWER_PROFILES.novice)).toBeLessThan(power(POWER_PROFILES.average));
    expect(power(POWER_PROFILES.average)).toBeLessThan(power(POWER_PROFILES.full));
  });

  it("слабое устройство режет потолок живых до caps.light, обычное — нет", () => {
    // Секунда глубоко в забеге: желаемый потолок «Сложной» с подстройкой выше потолка слабого устройства.
    const standard = worldOf(POWER_PROFILES.average, 900);
    standard.update();
    const light = worldOf(withDevice(POWER_PROFILES.average, "light"), 900);
    light.update();

    expect(light.world.difficulty.maxAlive).toBeLessThanOrEqual(PRESSURE.devices.caps.light);
    expect(standard.world.difficulty.maxAlive).toBeGreaterThan(PRESSURE.devices.caps.light);
  });
});

describe("бот калибровки", () => {
  it("без набора идёт как раньше: подстройку не включают ни выключатель, ни открытие по уровню", () => {
    const plain = simulateBalanceRun({ seed: 3, skill: "dodging", maxSec: 240 });
    expect(simulateBalanceRun({ seed: 3, skill: "dodging", maxSec: 240, pressure: false })).toEqual(plain);
    expect(simulateBalanceRun({ seed: 3, skill: "dodging", maxSec: 240, accountLevel: TOP_LEVEL })).toEqual(plain);
  });

  it("профиль включает подстройку и мягчит бой новичку", () => {
    const off = simulateBalanceRun({ seed: 3, skill: "dodging", maxSec: 240, loadout: POWER_PROFILES.novice.loadout, pressure: false });
    const on = simulateBalanceRun({ seed: 3, skill: "dodging", maxSec: 240, loadout: POWER_PROFILES.novice.loadout });

    expect(off).toMatchObject({ startPressure: 1, endPressure: 1 });
    expect(on.startPressure).toBeLessThan(1);
    expect(on).not.toEqual(off);
  });

  it("детерминирован: два одинаковых вызова дают равный результат", () => {
    const options = { seed: 5, skill: "dodging", maxSec: 180, loadout: POWER_PROFILES.full.loadout } as const;
    expect(simulateBalanceRun(options)).toEqual(simulateBalanceRun(options));
  });

  it("оценка набора по минутам: столько же значений, сколько полных минут, и каждое от 0 до 1", () => {
    const run = simulateBalanceRun({ seed: 2, skill: "dodging", maxSec: 600, godMode: true, loadout: POWER_PROFILES.average.loadout, pressure: false });
    expect(run.buildScoreByMinute).toHaveLength(Math.floor(run.survivalSec / 60));
    expect(run.buildScoreByMinute.length).toBeGreaterThan(0);
    for (const score of run.buildScoreByMinute) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
