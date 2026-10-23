import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Эволюции — записи в `WEAPONS` (tasks/T-0102): выбор оружия, счёт открытого и
// «с первого уровня» в гайдбуке обязаны идти по базовым, иначе эволюция попала
// бы в список стартовых и в «открыто N из M» вдвое больше настоящего. До
// T-0103 эволюции в этих местах нет.

const SOURCES = ["screens/pre-run.tsx", "screens/meta/level.tsx", "screens/guide/guide-data.ts", "state/dev-mode.ts"];

/** `WEAPONS` отдельным словом, не `BASE_WEAPONS` и не `SIM_WEAPONS`. */
const BARE_WEAPONS = /(?<![A-Za-z0-9_])WEAPONS\b/;

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");
}

describe("списки оружия в оболочке", () => {
  it.each(SOURCES)("%s берёт базовое оружие, а не весь WEAPONS", (path) => {
    const lines = source(path).split("\n");
    const offenders = lines.map((line, index) => ({ line, number: index + 1 })).filter(({ line }) => BARE_WEAPONS.test(line));
    expect(offenders, path).toEqual([]);
  });

  it("и базовые взяты у ядра: BASE_WEAPONS есть в каждом из мест", () => {
    for (const path of SOURCES) expect(source(path), path).toContain("BASE_WEAPONS");
  });
});
