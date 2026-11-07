import { readFileSync } from "node:fs";
import { RUN_MODIFIER_IDS, RUN_MODIFIER_REWARD_MUL, type RunModifierDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { DIFFICULTIES, findDifficulty } from "../src/content/difficulty";
import { findRunModifier, MAX_MODIFIERS_PER_RUN, RUN_MODIFIERS } from "../src/content/modifiers";
import { ACCOUNT_UNLOCKS } from "../src/content/unlocks";
import { createRunWorld } from "../src/game/run-world";
import { BASE_DIFFICULTY, composeDifficulty, findModifierProblems, resolveModifierIds } from "../src/game/sim/difficulty";

// Модификаторы забега (tasks/T-0119, Р105): «Спешка» и «Инверсия» ложатся
// умножением поверх выбранной сложности. Здесь — данные, их проверка и то, как
// модификатор попадает в мир; опыт кристаллов — gem-drops.test.ts, снимок и
// запись — run-snapshot.test.ts и run-recording.test.ts.

const texts = JSON.parse(readFileSync(new URL("../../app-shell/src/i18n/ru.json", import.meta.url), "utf8")) as Record<string, string>;

const HURRY: RunModifierDef = {
  id: "hurry",
  nameKey: "modifier.hurry.name",
  descriptionKey: "modifier.hurry.description",
  enemyHpMul: 1,
  enemyDamageMul: 1.1,
  spawnRateMul: 1.5,
  maxAliveMul: 1.25,
  xpMul: 1.5,
};

/** Запись с одной испорченной осью — для негативных проверок. */
function broken(patch: Partial<RunModifierDef>): RunModifierDef {
  return { ...HURRY, ...patch };
}

describe("данные модификаторов", () => {
  it("боевой список проходит проверку без замечаний", () => {
    expect(findModifierProblems(RUN_MODIFIERS)).toEqual([]);
  });

  it("список — ровно id из shared-types и в том же порядке", () => {
    expect(RUN_MODIFIERS.map((modifier) => modifier.id)).toEqual([...RUN_MODIFIER_IDS]);
    expect([...RUN_MODIFIER_IDS]).toEqual(["hurry", "inverse"]);
  });

  it("числа из таблицы решения: «Спешка» и «Инверсия»", () => {
    expect(findRunModifier("hurry")).toMatchObject({ enemyHpMul: 1, enemyDamageMul: 1.1, spawnRateMul: 1.5, maxAliveMul: 1.25, xpMul: 1.5 });
    expect(findRunModifier("inverse")).toMatchObject({ enemyHpMul: 2, enemyDamageMul: 1.3, spawnRateMul: 0.6, maxAliveMul: 0.7, xpMul: 1.6 });
    expect(findRunModifier("nope")).toBeUndefined();
  });

  it("один модификатор на забег", () => {
    expect(MAX_MODIFIERS_PER_RUN).toBe(1);
  });

  it("награда за забег — отдельная таблица в shared-types, ×1,25 у обоих, и на каждый id есть запись", () => {
    for (const id of RUN_MODIFIER_IDS) expect(RUN_MODIFIER_REWARD_MUL[id], id).toBe(1.25);
    expect(Object.keys(RUN_MODIFIER_REWARD_MUL).sort()).toEqual([...RUN_MODIFIER_IDS].sort());
  });

  it("тексты имени и описания есть в ru.json, а описание — слово в слово из решения", () => {
    for (const modifier of RUN_MODIFIERS) {
      expect(texts[modifier.nameKey], modifier.nameKey).toBeTruthy();
      expect(texts[modifier.descriptionKey], modifier.descriptionKey).toBeTruthy();
    }
    expect(texts["modifier.hurry.name"]).toBe("Спешка");
    expect(texts["modifier.hurry.description"]).toBe("Врагов на полтора раза больше и они чуть злее, зато опыт в бою растёт быстрее.");
    expect(texts["modifier.inverse.name"]).toBe("Инверсия");
    expect(texts["modifier.inverse.description"]).toBe("Врагов меньше, но они вдвое крепче и бьют больнее. Опыт в бою растёт быстрее.");
  });

  it("общий запас здоровья орды «Инверсии» выше базы (×1,2), «Спешки» — не ниже", () => {
    const inverse = findRunModifier("inverse");
    const hurry = findRunModifier("hurry");
    expect((inverse?.enemyHpMul ?? 0) * (inverse?.spawnRateMul ?? 0)).toBeCloseTo(1.2, 10);
    expect((hurry?.enemyHpMul ?? 0) * (hurry?.spawnRateMul ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("проверка данных модификатора называет запись и поле", () => {
  it("ноль, отрицательное и NaN в любой оси", () => {
    for (const key of ["enemyHpMul", "enemyDamageMul", "spawnRateMul", "maxAliveMul", "xpMul"] as const) {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const problems = findModifierProblems([broken({ [key]: bad })]).join("\n");
        expect(problems, `${key} = ${String(bad)}`).toMatch(new RegExp(`hurry.*${key}.*больше нуля`));
      }
    }
  });

  it("повтор id и id вне списка", () => {
    expect(findModifierProblems([HURRY, HURRY]).join("\n")).toMatch(/hurry.*id повторяется/);
    const outside = findModifierProblems([{ ...HURRY, id: "chaos" as RunModifierDef["id"] }]).join("\n");
    expect(outside).toMatch(/chaos.*id не из hurry, inverse/);
  });

  it("модификатор без отличий от сложности", () => {
    const plain = broken({ enemyDamageMul: 1, spawnRateMul: 1, maxAliveMul: 1, xpMul: 1 });
    expect(findModifierProblems([plain]).join("\n")).toMatch(/hurry.*ничем не отличается/);
  });

  it("здоровье · темп спавна ниже единицы: орда слабее базы, а награда за неё выше", () => {
    const weak = broken({ enemyHpMul: 1.4, spawnRateMul: 0.5 });
    expect(findModifierProblems([weak]).join("\n")).toMatch(/hurry.*здоровье · темп спавна/);
  });

  it("опыт в бою ниже единицы", () => {
    expect(findModifierProblems([broken({ xpMul: 0.9 })]).join("\n")).toMatch(/hurry.*xpMul.*не меньше 1/);
  });

  it("пустые ключи текста", () => {
    const problems = findModifierProblems([broken({ nameKey: "", descriptionKey: " " })]).join("\n");
    expect(problems).toMatch(/hurry.*nameKey/);
    expect(problems).toMatch(/hurry.*descriptionKey/);
  });
});

describe("composeDifficulty", () => {
  const easy = findDifficulty("easy") ?? BASE_DIFFICULTY;
  const hard = findDifficulty("hard") ?? BASE_DIFFICULTY;

  it("без модификатора значения равны базе, объект не тот же и xpMul не заводится", () => {
    const composed = composeDifficulty(hard, [], RUN_MODIFIERS);
    expect(composed).toEqual(hard);
    expect(composed).not.toBe(hard);
    expect(composed.xpMul).toBeUndefined();
  });

  it("«Лёгкая» + «Спешка» — оси из таблицы, id остаётся базовым", () => {
    const composed = composeDifficulty(easy, ["hurry"], RUN_MODIFIERS);
    expect(composed).toMatchObject({
      id: "easy",
      nameKey: easy.nameKey,
      descriptionKey: easy.descriptionKey,
      enemyHpMul: 1,
      enemyDamageMul: 1.1,
      spawnRateMul: 1.5,
      maxAliveMul: 1.25,
      xpMul: 1.5,
    });
  });

  it("«Сложная» + «Инверсия» — произведения осей", () => {
    const composed = composeDifficulty(hard, ["inverse"], RUN_MODIFIERS);
    expect(composed.id).toBe("hard");
    expect(composed.enemyHpMul).toBeCloseTo(hard.enemyHpMul * 2, 10);
    expect(composed.enemyDamageMul).toBeCloseTo(hard.enemyDamageMul * 1.3, 10);
    expect(composed.spawnRateMul).toBeCloseTo(hard.spawnRateMul * 0.6, 10);
    expect(composed.maxAliveMul).toBeCloseTo(hard.maxAliveMul * 0.7, 10);
    expect(composed.xpMul).toBe(1.6);
  });

  it("базу не меняет, а незнакомый id пропускает", () => {
    const before = JSON.stringify(hard);
    composeDifficulty(hard, ["hurry"], RUN_MODIFIERS);
    expect(JSON.stringify(hard)).toBe(before);
    expect(composeDifficulty(hard, ["nope"], RUN_MODIFIERS)).toEqual(hard);
  });

  it("на всех сложностях модификатор не делает врагов слабее по здоровью и темпу вместе", () => {
    for (const base of DIFFICULTIES) {
      for (const modifier of RUN_MODIFIERS) {
        const composed = composeDifficulty(base, [modifier.id], RUN_MODIFIERS);
        expect(composed.enemyHpMul * composed.spawnRateMul, `${base.id} + ${modifier.id}`).toBeGreaterThanOrEqual(base.enemyHpMul * base.spawnRateMul);
      }
    }
  });
});

describe("resolveModifierIds", () => {
  const open = new Set(["hurry", "inverse"]);

  it("оставляет известный, снимает повтор и незнакомое, держит потолок", () => {
    expect(resolveModifierIds(["hurry"], RUN_MODIFIERS, 1, null)).toEqual(["hurry"]);
    expect(resolveModifierIds(["nope", "hurry"], RUN_MODIFIERS, 1, null)).toEqual(["hurry"]);
    expect(resolveModifierIds(["hurry", "hurry"], RUN_MODIFIERS, 2, null)).toEqual(["hurry"]);
    expect(resolveModifierIds(["hurry", "inverse"], RUN_MODIFIERS, 1, null)).toEqual(["hurry"]);
    expect(resolveModifierIds(["hurry", "inverse"], RUN_MODIFIERS, 2, null)).toEqual(["hurry", "inverse"]);
    expect(resolveModifierIds(undefined, RUN_MODIFIERS, 1, null)).toEqual([]);
  });

  it("закрытый уровнем аккаунта не попадает в мир, а открытый — да", () => {
    expect(resolveModifierIds(["hurry"], RUN_MODIFIERS, 1, new Set())).toEqual([]);
    expect(resolveModifierIds(["inverse"], RUN_MODIFIERS, 1, new Set(["hurry"]))).toEqual([]);
    expect(resolveModifierIds(["inverse"], RUN_MODIFIERS, 1, open)).toEqual(["inverse"]);
  });
});

describe("модификатор в мире забега", () => {
  const base = { seed: 7, mapId: "", difficultyId: "hard" as const, unitScale: 1 };

  it("без поля забег без модификатора: сложность как в контенте", () => {
    const { world } = createRunWorld(base);
    expect(world.modifierIds).toEqual([]);
    expect(world.difficultyLevel).toEqual(findDifficulty("hard"));
  });

  it("«Спешка» складывается с «Сложной», id сложности остаётся", () => {
    const { world } = createRunWorld({ ...base, modifierIds: ["hurry"] });
    const hard = findDifficulty("hard");
    expect(world.modifierIds).toEqual(["hurry"]);
    expect(world.difficultyLevel.id).toBe("hard");
    expect(world.difficultyLevel.spawnRateMul).toBeCloseTo((hard?.spawnRateMul ?? 0) * 1.5, 10);
    expect(world.difficultyLevel.xpMul).toBe(1.5);
  });

  it("директор берёт множители составленной сложности: «Инверсия» вдвое крепче врагов", () => {
    const plain = createRunWorld(base);
    const inverse = createRunWorld({ ...base, modifierIds: ["inverse"] });
    plain.spawner.update(plain.world, 1 / 60);
    inverse.spawner.update(inverse.world, 1 / 60);
    expect(inverse.world.difficulty.hpMul / plain.world.difficulty.hpMul).toBeCloseTo(2, 10);
    expect(inverse.world.difficulty.damageMul / plain.world.difficulty.damageMul).toBeCloseTo(1.3, 10);
    expect(inverse.world.difficulty.maxAlive).toBeLessThan(plain.world.difficulty.maxAlive);
  });

  it("уровень аккаунта решает, что в мире есть: «Спешка» закрыта на 8-м уровне и открыта на 9-м", () => {
    const at = (accountLevel: number, id: "hurry" | "inverse") =>
      createRunWorld({ ...base, modifierIds: [id], loadout: { modifiers: {}, boosts: [], accountLevel } }).world.modifierIds;
    expect(at(8, "hurry")).toEqual([]);
    expect(at(9, "hurry")).toEqual(["hurry"]);
    expect(at(11, "inverse")).toEqual([]);
    expect(at(12, "inverse")).toEqual(["inverse"]);
  });

  it("в прологе модификаторов нет: у него своя сложность", () => {
    const { world } = createRunWorld({ ...base, mode: "prologue", modifierIds: ["hurry"] });
    expect(world.modifierIds).toEqual([]);
    expect(world.difficultyLevel.xpMul).toBeUndefined();
  });

  it("таблица разблокировок строит открытие модификаторов по контенту", () => {
    expect(ACCOUNT_UNLOCKS.some((row) => row.modifiers !== undefined)).toBe(true);
  });
});
