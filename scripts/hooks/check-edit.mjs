// PostToolUse для Edit|Write на *.ts и *.tsx: быстрые проверки одного файла сразу
// после правки (docs/35-stage4-plan.md, Р224 A), а не через пятнадцать минут CI.
//
// Находки уходят в stderr с кодом 2: правка уже сделана и не откатывается —
// код 2 после выполнения лишь показывает текст агенту, чтобы он починил файл.
// Проверки те же, что в тестах: eslint, чистота симуляции
// (`packages/core-game/test/sim-purity.test.ts`) и границы слоёв
// (`scripts/test/layer-boundaries.test.ts`, общий список — `layer-rules.mjs`).
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain, runHook } from "./io.mjs";
import { findLayerViolations } from "./layer-rules.mjs";

const ESLINT_TIMEOUT_MS = 20_000;
const MAX_SIZE_BYTES = 1_000_000;
const MAX_ESLINT_LINES = 15;

/** Запрещённая в симуляции приближённая математика — список совпадает с sim-purity.test.ts (его сверяет тест). */
export const SIM_FORBIDDEN_MATH = /Math\.(hypot|pow|sin|cos|tan|asin|acos|atan|atan2|exp|log|log2|log10|cbrt)\b/;

const SIM_DIRS = ["sim", "patterns", "weapons", "progression", "run", "balance", "diagnostics"];
const SIM_PREFIX = "packages/core-game/src/game/";
const SIM_FILES = new Set([`${SIM_PREFIX}bench/autopilot.ts`]);

const PURITY_RULES = [
  {
    pattern: /Math\.random/g,
    hint: "рандом только через инжектируемый seeded-генератор (world.rng или собственный поток rng.ts)",
  },
  {
    pattern: new RegExp(SIM_FORBIDDEN_MATH.source, "g"),
    hint: "приближённая математика расходится между JS-движками: длина — Math.sqrt, степень — умножением в цикле, направления — game/sim/directions.ts",
  },
  {
    pattern: /Date\.now|new Date\(|performance\.now/g,
    hint: "время в симуляции — только тики; часы читает сцена, а не симуляция",
  },
  {
    pattern: /from\s+["']phaser["']/gi,
    hint: "симуляция работает без Phaser: движок рисует сцена, а не слой симуляции",
    label: "импорт Phaser",
  },
  {
    pattern: /@bh\/adapter-|backend\//g,
    hint: "симуляция не знает ни площадок, ни бэкенда",
    label: "импорт адаптера или бэкенда",
  },
];

/** Файл входит в слой симуляции, на который распространяется sim-purity. */
export function isSimFile(rel) {
  if (SIM_FILES.has(rel)) return true;
  return SIM_DIRS.some((dir) => rel.startsWith(`${SIM_PREFIX}${dir}/`));
}

/** Комментарии вырезаются, а переводы строк остаются — номера строк в находках должны совпасть с файлом. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/.*/g, (line) => " ".repeat(line.length));
}

function findPurityViolations(rel, source) {
  if (!isSimFile(rel)) return [];
  const lines = stripComments(source).split("\n");
  const found = [];
  for (const rule of PURITY_RULES) {
    for (let index = 0; index < lines.length; index += 1) {
      rule.pattern.lastIndex = 0;
      const match = rule.pattern.exec(lines[index]);
      if (match) found.push(`sim-purity: ${rule.label ?? match[0]} в ${rel}:${index + 1} — ${rule.hint}`);
    }
  }
  return found;
}

/** Находки чистоты симуляции и границ слоёв в одном файле; путь — от корня репозитория. */
export function checkSource(rel, source) {
  const path = rel.replace(/\\/g, "/");
  return [...findPurityViolations(path, source), ...findLayerViolations(path, source)];
}

/** Вывод `eslint -f json` → строки «eslint: строка:колонка уровень правило — текст»; мусор вместо JSON — пусто. */
export function formatEslintJson(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(report)) return [];
  const lines = report
    .flatMap((entry) => (Array.isArray(entry?.messages) ? entry.messages : []))
    .map((message) => `eslint: ${message.line ?? 0}:${message.column ?? 0} ${message.severity === 2 ? "ошибка" : "предупреждение"} ${message.ruleId ?? ""} — ${message.message}`);
  if (lines.length <= MAX_ESLINT_LINES) return lines;
  return [...lines.slice(0, MAX_ESLINT_LINES), `eslint: … и ещё ${lines.length - MAX_ESLINT_LINES}`];
}

/** eslint одного файла: строки находок или пусто; поломка самого eslint находкой не считается. */
function runEslint(root, file) {
  if (process.env.CLAUDE_HOOKS_SKIP_ESLINT) return [];
  const windows = process.platform === "win32";
  // Формат json, а не unix: unix вынесен из ядра ESLint в отдельный пакет
  const result = spawnSync("pnpm", ["exec", "eslint", "--no-warn-ignored", "-f", "json", windows ? `"${file}"` : file], {
    cwd: root,
    encoding: "utf8",
    timeout: ESLINT_TIMEOUT_MS,
    shell: windows,
  });
  if (result.error || typeof result.stdout !== "string") return [];
  return formatEslintJson(result.stdout);
}

function projectRoot() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  return resolve(fromEnv && fromEnv !== "" ? fromEnv : resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
}

if (isMain(import.meta.url)) {
  await runHook("check-edit", (input) => {
    const toolInput = input.tool_input;
    if (toolInput === null || typeof toolInput !== "object") return null;
    const filePath = toolInput.file_path;
    if (typeof filePath !== "string" || !/\.tsx?$/.test(filePath)) return null;

    const root = projectRoot();
    const file = resolve(root, filePath);
    const rel = relative(root, file).replace(/\\/g, "/");
    if (rel.startsWith("..") || isAbsolute(rel)) return null;

    let size;
    try {
      size = statSync(file).size;
    } catch {
      return null;
    }
    if (size > MAX_SIZE_BYTES) return null;

    const found = [...checkSource(rel, readFileSync(file, "utf8")), ...runEslint(root, file)];
    if (found.length === 0) return null;
    return [`После правки ${rel} найдено (правка сделана, исправь):`, ...found].join("\n");
  });
}
