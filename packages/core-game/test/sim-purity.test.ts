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
// Оружие и прокачка — такая же часть симуляции: от них зависит исход забега,
// значит на них распространяются те же запреты (docs/26-stage2-plan.md, WP2).
const weaponsRoot = fileURLToPath(new URL("../src/game/weapons", import.meta.url));
const progressionRoot = fileURLToPath(new URL("../src/game/progression", import.meta.url));
// Итог забега и локальный рекорд: сам забег они не считают, но обязаны
// работать headless — их гоняет тест статистики, а позже и серверная
// перепроверка забега (docs/17-testing-strategy.md §3.5).
const runRoot = fileURLToPath(new URL("../src/game/run", import.meta.url));
// Бот калибровки гоняет ту же симуляцию и обязан быть таким же
// детерминированным: иначе таблица `pnpm balance:sim` меняется от запуска к
// запуску (docs/26-stage2-plan.md, WP4.6).
const balanceRoot = fileURLToPath(new URL("../src/game/balance", import.meta.url));
// Скрипт ввода стенда — часть прогона: от него зависит и замер, и эталонный
// забег, значит на него распространяются те же запреты.
const autopilotPath = fileURLToPath(new URL("../src/game/bench/autopilot.ts", import.meta.url));
// Диагностика забега: статистика кадров, запись и повтор. Повтор гоняет
// симуляцию и обязан дать тот же исход на любом движке, а запись не должна
// сама читать часы — время кадра ей приносит сцена (docs/28-diagnostics.md §3.1).
const diagnosticsRoot = fileURLToPath(new URL("../src/game/diagnostics", import.meta.url));

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

const sources = [
  ...collectSources(simRoot),
  ...collectSources(patternsRoot),
  ...collectSources(weaponsRoot),
  ...collectSources(progressionRoot),
  ...collectSources(runRoot),
  ...collectSources(balanceRoot),
  ...collectSources(diagnosticsRoot),
  { path: autopilotPath, source: stripComments(readFileSync(autopilotPath, "utf8")) },
];

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

  it("покрывает каждое поведение оружия", () => {
    const files = sources.map(({ path }) => path.replace(/\\/g, "/"));
    for (const name of ["projectile-nearest", "projectile-facing", "orbit", "aura", "area-strike"]) {
      expect(files.some((file) => file.endsWith(`/weapons/${name}.ts`)), name).toBe(true);
    }
  });

  it("не использует приближённую математику — она расходится между JS-движками", () => {
    // Повтор забега с iOS на машине разработчика требует побитово одинаковой
    // математики: `sin`, `cos`, `atan2`, `hypot`, `exp`, `pow` по спецификации
    // ECMAScript приближённые, и V8 с JavaScriptCore вправе разойтись в
    // последних битах (docs/26-stage2-plan.md, WP4.5).
    //
    // Чем заменяем: длина вектора — `Math.sqrt`, он по IEEE 754 точный;
    // степень — умножением в цикле; направления — отбором в круге, разложением
    // по базису и таблицей литералов (sim/directions.ts).
    //
    // Камера и рендер под запрет не попадают сознательно: на исход забега они
    // не влияют, а `Math.exp` в сглаживании даёт независимость от частоты кадров.
    const forbidden =
      /Math\.(hypot|pow|sin|cos|tan|asin|acos|atan|atan2|exp|log|log2|log10|cbrt)\b/;
    for (const { path, source } of sources) {
      expect(source, path).not.toMatch(forbidden);
    }
  });

  it("не использует Date.now, new Date и performance.now", () => {
    for (const { path, source } of sources) {
      expect(source, path).not.toMatch(/Date\.now|new Date\(|performance\.now/);
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
