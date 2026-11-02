import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Единая сложность по исходникам (T-0190, Р126; в духе
 * `scripts/test/layer-boundaries.test.ts`): выбора сложности в оболочке нет, и
 * вернуть его случайно — значит снова развести рекорды и таблицы.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function sources(sub: string): { path: string; text: string }[] {
  return files(join(SRC, sub)).map((path) => ({ path: relative(SRC, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));
}

const UI_AND_STATE = [...sources("screens"), ...sources("state")];

function offenders(pattern: RegExp, allowed: string[] = []): string[] {
  return UI_AND_STATE.filter((file) => !allowed.includes(file.path) && pattern.test(file.text)).map((file) => file.path);
}

describe("единая сложность: выбора в оболочке нет", () => {
  it("rememberDifficulty нигде не остался", () => {
    expect(offenders(/rememberDifficulty/)).toEqual([]);
  });

  it("lastDifficultyId живёт только в схеме прежнего профиля", () => {
    expect(offenders(/lastDifficultyId/, ["state/meta.ts"])).toEqual([]);
    const meta = readFileSync(join(SRC, "state/meta.ts"), "utf8");
    const mentions = meta.split("\n").filter((line) => line.includes("lastDifficultyId") && !line.trim().startsWith("*") && !line.trim().startsWith("//"));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toContain("z.optional");
  });

  it("заголовка и списка сложностей в интерфейсе нет", () => {
    expect(offenders(/difficulty\.title/)).toEqual([]);
    expect(offenders(/DIFFICULTIES\.map/)).toEqual([]);
  });

  it("лист «Перед забегом» и рейтинг не рисуют переключатель сложности", () => {
    for (const file of ["screens/pre-run.tsx", "screens/meta/rating.tsx"]) {
      const text = readFileSync(join(SRC, file), "utf8");
      expect(text, file).not.toMatch(/SegmentedControl/);
      expect(text, file).not.toMatch(/\bDIFFICULTIES\b/);
    }
  });
});
