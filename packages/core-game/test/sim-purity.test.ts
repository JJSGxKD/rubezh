import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Проверка исходников, а не поведения — сознательно.
// Запреты из CLAUDE.md («весь рандом через инжектируемый seeded-генератор,
// никаких Math.random() и Date.now() внутри симуляции») и требование
// headless-прогона (docs/17-testing-strategy.md §3.0) иначе держатся только
// на внимательности ревьюера. Нарушение всплыло бы не сразу, а через
// плавающий golden-тест — то есть в виде флейка, который чинят наугад.

const simRoot = fileURLToPath(new URL("../src/game/sim", import.meta.url));
const patternsRoot = fileURLToPath(new URL("../src/game/patterns", import.meta.url));

/**
 * Комментарии вырезаются перед проверкой: иначе тест падает на собственных
 * пояснениях вида «Math.random здесь запрещён». Разбор упрощённый — в этом
 * слое нет строковых литералов с последовательностью из двух слэшей, а
 * появление такого литерала безопаснее ложного срабатывания, чем настоящий
 * парсер ради пяти регулярок.
 */
export function stripComments(source: string): string {
  const blockComment = /\/\*[\s\S]*?\*\//g;
  const lineComment = /\/\/.*/g;
  return source.replace(blockComment, " ").replace(lineComment, " ");
}

function collectSources(root: string): { path: string; source: string }[] {
  const result: { path: string; source: string }[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      result.push(...collectSources(path));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    result.push({ path, source: stripComments(readFileSync(path, "utf8")) });
  }
  return result;
}

const sources = [...collectSources(simRoot), ...collectSources(patternsRoot)];

describe("чистота слоя симуляции", () => {
  it("вообще находит исходники — иначе тест зелёный впустую", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("вырезает комментарии, но оставляет код — иначе проверки ниже бессмысленны", () => {
    const stripped = stripComments("// про Math.random\nconst a = Math.random();\n/* Date.now */");
    expect(stripped).toMatch(/const a = Math\.random\(\);/);
    expect(stripped).not.toMatch(/про/);
    expect(stripped).not.toMatch(/Date\.now/);
  });

  it("не использует Math.random", () => {
    for (const { path, source } of sources) {
      expect(source, path).not.toMatch(/Math\.random/);
    }
  });

  it("покрывает каждый паттерн поведения — новые файлы не выпадают из проверки", () => {
    const files = sources.map(({ path }) => path.replace(/\\/g, "/"));
    for (const name of ["swarm", "chase", "kite-and-shoot", "dash", "orbit", "exploder", "splitter"]) {
      expect(files.some((file) => file.endsWith(`/patterns/${name}.ts`)), name).toBe(true);
    }
  });

  it("не использует Math.hypot — он приближённый и расходится между JS-движками", () => {
    // Повтор забега с iOS на машине разработчика требует побитово одинаковой
    // математики (docs/26-stage2-plan.md, WP4.5). Длина вектора — через
    // Math.sqrt, он по IEEE 754 точный. Запрет тригонометрии добавится вместе
    // с переписыванием спавнера, где она пока живёт.
    for (const { path, source } of sources) {
      expect(source, path).not.toMatch(/Math\.hypot/);
    }
  });

  it("не использует Date.now и new Date", () => {
    for (const { path, source } of sources) {
      expect(source, path).not.toMatch(/Date\.now|new Date\(/);
    }
  });

  it("не импортирует Phaser", () => {
    for (const { path, source } of sources) {
      expect(source, path).not.toMatch(/from\s+["']phaser["']/i);
    }
  });

  it("не импортирует платформенные адаптеры и бэкенд", () => {
    for (const { path, source } of sources) {
      expect(source, path).not.toMatch(/@bh\/adapter-|backend\//);
    }
  });
});
