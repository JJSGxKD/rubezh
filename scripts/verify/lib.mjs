// pnpm verify (T-0474, docs/35-stage4-plan.md Р224, B): чистая часть — какие
// пакеты затронуты, какие шаги и командами запускать, как собрать отчёт для
// PR и какой код выхода вернуть. Ничего не запускает и не читает: git, файлы
// и процессы — в `verify.mjs`, поэтому всё здесь проверяется обычными тестами.

/** Корневые файлы, от которых зависит каждый пакет: правка любого задевает всё. */
const ROOT_CONFIG = /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|vitest[^/]*\.config\.ts|eslint\.config\.js)$/;

/** Пакеты, чей код уезжает на устройство: их правка требует сборки и бюджета бандла. */
export const BUILD_UNITS = [
  "packages/app-shell",
  "apps/web-telegram",
  "apps/web-max",
  "apps/web-vk",
  "apps/admin",
];

const BACKEND_UNIT = "backend/api";
const DB_URL_ALLOWED = /rubezh_test/;
const DB_URL_FORBIDDEN = /bullet_heaven/;

/** Файлов в одной команде eslint: командная строка Windows короче, чем кажется. */
const LINT_CHUNK = 40;
/** Сколько проблем упавшего шага показываем до «…и ещё N». */
const MAX_PROBLEMS = 5;

const MINUTE = 60_000;
const TIMEOUTS = {
  typecheck: 10 * MINUTE,
  lint: 5 * MINUTE,
  tests: 15 * MINUTE,
  // Все пакеты сразу на общей машине с шестью агентами идут дольше четверти часа.
  testsAll: 45 * MINUTE,
  build: 12 * MINUTE,
  zones: MINUTE,
  docs: 2 * MINUTE,
  db: 15 * MINUTE,
};

const slashes = (path) => String(path).replace(/\\/g, "/");
const unique = (list) => [...new Set(list)];

/**
 * Какие пакеты затронул дифф. Пакет — ближайший каталог с `package.json`;
 * `scripts/**` — отдельный блок «scripts»; корневые конфиги задевают всё;
 * документы, задачи, скиллы и любой markdown ничего не затрагивают.
 */
export function affectedUnits(files, packageDirs) {
  // Длинный префикс первым: вложенный пакет обязан побеждать внешний.
  const dirs = [...packageDirs].map(slashes).sort((a, b) => b.length - a.length);
  let all = false;
  const units = new Set();
  for (const raw of files) {
    const file = slashes(raw);
    if (file.endsWith(".md")) continue;
    if (!file.includes("/") && ROOT_CONFIG.test(file)) {
      all = true;
      continue;
    }
    const dir = dirs.find((candidate) => file.startsWith(`${candidate}/`));
    if (dir !== undefined) {
      units.add(dir);
      continue;
    }
    if (file.startsWith("scripts/")) {
      units.add("scripts");
      continue;
    }
    // Остальное — документы, задачи, скиллы, CI, инфраструктура: кода пакетов там нет.
  }
  return { all, units: [...units].sort() };
}

/**
 * Затронутые пакеты вместе с теми, кто от них зависит: правка нижнего пакета
 * ломает потребителей, и их тесты обязаны пройти. `graph` — каталог пакета →
 * каталоги пакетов, от которых он зависит.
 */
export function withDependents(units, graph) {
  const result = new Set(units);
  const queue = [...units];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const [dir, deps] of Object.entries(graph)) {
      if (!result.has(dir) && deps.includes(current)) {
        result.add(dir);
        queue.push(dir);
      }
    }
  }
  return [...result].sort();
}

/**
 * Правка корневого `package.json` задевает всё, но новый скрипт `pnpm` —
 * нет: если отличается только раздел `scripts`, остальное не поменялось.
 * Нечитаемое или отсутствующее — осторожно «нет»: тогда задевает всё.
 */
export function onlyScriptsChanged(before, after) {
  if (typeof before !== "string" || typeof after !== "string") return false;
  try {
    const { scripts: _before, ...restBefore } = JSON.parse(before);
    const { scripts: _after, ...restAfter } = JSON.parse(after);
    return JSON.stringify(restBefore) === JSON.stringify(restAfter);
  } catch {
    return false;
  }
}

/** Файлы для eslint: только существующие `.ts` и `.tsx` (удалённым линтить нечего), без сценариев Workflow. */
export function lintCandidates(files, exists) {
  return files
    .map(slashes)
    .filter((file) => /\.tsx?$/.test(file) && !file.startsWith(".claude/workflows/") && exists(file));
}

/** Короткое имя блока для таблицы: `packages/core-game` → `core-game`, `backend/api` → `api`. */
export function unitLabel(dir) {
  return dir === "scripts" ? "scripts" : dir.split("/").slice(1).join("/");
}

const testFilter = (dir) => (dir === "scripts" ? "scripts/test/" : `${dir}/`);

function plural(count, one, few, many) {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return many;
  const last = count % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

const pluralFailed = (count) => plural(count, "упал", "упали", "упало");
const pluralFiles = (count) => plural(count, "файл", "файла", "файлов");
const pluralErrors = (count) => plural(count, "ошибка", "ошибки", "ошибок");

const pnpm = (...args) => ({ cmd: "pnpm", args });

const skipped = (id, label, skipReason) => ({ id, label, skipReason, timeoutMs: TIMEOUTS[id], commands: [], unsetEnv: [] });

/**
 * План шагов проверки по списку файлов диффа. Каждый шаг: `id`, подпись для
 * таблицы, `skipReason` (не `null` — шаг пропущен и почему), команды и
 * таймаут. Состояние окружения (`env`, `exists`) приходит снаружи.
 *
 * Параметры: `files` — дифф; `dirs` — каталоги пакетов; `graph` — зависимости
 * пакетов; `db` — флаг `--db`; `env` — окружение (нужен `TEST_DATABASE_URL`);
 * `exists` — существует ли файл; `base` — ветка для проверки зон.
 */
export function planSteps({ files, dirs, graph, db, env, exists, base = "origin/dev" }) {
  const { all, units } = affectedUnits(files, dirs);
  const expanded = all ? [] : withDependents(units, graph);
  const hasCode = all || units.length > 0;
  const touches = (dir) => all || expanded.includes(dir);

  const typecheck = hasCode
    ? { id: "typecheck", label: "typecheck", skipReason: null, timeoutMs: TIMEOUTS.typecheck, commands: [pnpm("typecheck")], unsetEnv: [] }
    : skipped("typecheck", "typecheck", "код не затронут");

  const lintFiles = lintCandidates(files, exists);
  const lintCommands = [];
  for (let index = 0; index < lintFiles.length; index += LINT_CHUNK) {
    lintCommands.push(pnpm("exec", "eslint", "--no-warn-ignored", ...lintFiles.slice(index, index + LINT_CHUNK)));
  }
  const lint =
    lintFiles.length > 0
      ? { id: "lint", label: `lint (${String(lintFiles.length)} ${pluralFiles(lintFiles.length)})`, skipReason: null, timeoutMs: TIMEOUTS.lint, commands: lintCommands, unsetEnv: [] }
      : skipped("lint", "lint", "нет ts-файлов в диффе");

  // Шаг с базой: только по флагу и только на тестовой базе. Адрес dev-базы — отказ.
  const dbUrl = env.TEST_DATABASE_URL ?? "";
  const dbUrlOk = DB_URL_ALLOWED.test(dbUrl) && !DB_URL_FORBIDDEN.test(dbUrl);
  let dbStep;
  if (!db) dbStep = skipped("db", "интеграция с базой", "не запускались — проверит CI");
  else if (!touches(BACKEND_UNIT)) dbStep = skipped("db", "интеграция с базой", "бэкенд не затронут");
  else if (!dbUrlOk) dbStep = skipped("db", "интеграция с базой", "TEST_DATABASE_URL не указывает на rubezh_test — проверит CI");
  else dbStep = { id: "db", label: "интеграция с базой", skipReason: null, timeoutMs: TIMEOUTS.db, commands: [pnpm("exec", "vitest", "run", testFilter(BACKEND_UNIT))], unsetEnv: [] };
  const dbRuns = dbStep.skipReason === null;

  // Обычные тесты идут без адреса базы: интеграционные в них пропускаются сами,
  // а прогон с базой — отдельный шаг, который включается флагом.
  let tests;
  if (!hasCode) {
    tests = skipped("tests", "тесты", "код не затронут");
  } else if (all) {
    tests = { id: "tests", label: "тесты всех пакетов", skipReason: null, timeoutMs: TIMEOUTS.testsAll, commands: [pnpm("exec", "vitest", "run")], unsetEnv: ["TEST_DATABASE_URL"] };
  } else {
    const named = [...units, ...expanded.filter((dir) => !units.includes(dir))].filter((dir) => !(dbRuns && dir === BACKEND_UNIT));
    if (named.length === 0) {
      tests = skipped("tests", "тесты", "покрыты шагом с базой");
    } else {
      const filters = named.map(testFilter).sort();
      tests = {
        id: "tests",
        label: `тесты ${named.map(unitLabel).join(", ")}`,
        skipReason: null,
        timeoutMs: TIMEOUTS.tests,
        // Блок без тестовых файлов (приложение без своих тестов) — не провал.
        commands: [pnpm("exec", "vitest", "run", "--passWithNoTests", ...filters)],
        unsetEnv: ["TEST_DATABASE_URL"],
      };
    }
  }

  const needsBuild = hasCode && (all || BUILD_UNITS.some((dir) => expanded.includes(dir)));
  const build = needsBuild
    ? { id: "build", label: "build + budget", skipReason: null, timeoutMs: TIMEOUTS.build, commands: [pnpm("build"), pnpm("budget")], unsetEnv: [] }
    : skipped("build", "build + budget", "не затронуты");

  const zones = { id: "zones", label: "зоны задачи", skipReason: null, timeoutMs: TIMEOUTS.zones, commands: [{ cmd: "node", args: ["scripts/tasks/task.mjs", "diff-check", "--base", base] }], unsetEnv: [] };
  const docs = { id: "docs", label: "docs:check", skipReason: null, timeoutMs: TIMEOUTS.docs, commands: [pnpm("docs:check")], unsetEnv: [] };

  return [typecheck, lint, tests, build, zones, docs, dbStep];
}

/**
 * Исполняет план. `run(command)` возвращает `{ code, output, ms, timedOut }`;
 * первая упавшая команда шага останавливает шаг. Результат шага: `status`
 * (`ok`, `fail`, `skip`), `detail`, `ms` (`null` у пропущенного), `problems`.
 */
export function runPlan(plan, run) {
  return plan.map((step) => {
    if (step.skipReason !== null) {
      return { id: step.id, label: step.label, status: "skip", detail: step.skipReason, ms: null, problems: [] };
    }
    let ms = 0;
    for (const command of step.commands) {
      const outcome = run({ ...command, timeoutMs: step.timeoutMs, unsetEnv: step.unsetEnv ?? [] }, step);
      ms += outcome.ms;
      if (outcome.timedOut) {
        return { id: step.id, label: step.label, status: "fail", detail: `таймаут ${formatDuration(step.timeoutMs)}`, ms, problems: [] };
      }
      if (outcome.code !== 0) {
        const summary = summarizeFailure(step.id, outcome.output);
        return { id: step.id, label: step.label, status: "fail", detail: summary.detail, ms, problems: summary.problems };
      }
    }
    return { id: step.id, label: step.label, status: "ok", ms, problems: [] };
  });
}

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

function nonEmptyLines(output) {
  return stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function capProblems(problems) {
  if (problems.length <= MAX_PROBLEMS) return problems;
  return [...problems.slice(0, MAX_PROBLEMS), `…и ещё ${String(problems.length - MAX_PROBLEMS)}`];
}

const tail = (lines) => lines.slice(-MAX_PROBLEMS);

/**
 * Что показать из вывода упавшего шага: короткое пояснение для таблицы и
 * первые проблемы для раздела «Упало». Разбор — по виду вывода шага; если
 * не разобрался, берётся хвост вывода, чтобы красный шаг не был немым.
 */
export function summarizeFailure(id, output) {
  const lines = nonEmptyLines(output);

  if (id === "tests" || id === "db") {
    const names = unique(lines.map((line) => /^FAIL\s+(.+)$/.exec(line)?.[1]).filter((name) => name !== undefined));
    const summary = lines.map((line) => /^Tests\s+(\d+) failed/.exec(line)).find((match) => match !== null);
    const count = summary ? Number(summary[1]) : names.length;
    if (count === 0 && names.length === 0) return { detail: "упали", problems: capProblems(tail(lines)) };
    return { detail: `${String(count)} ${pluralFailed(count)}`, problems: capProblems(names.length > 0 ? names : tail(lines)) };
  }

  if (id === "typecheck") {
    const errors = unique(lines.filter((line) => /error TS\d+/.test(line)));
    if (errors.length === 0) return { detail: undefined, problems: capProblems(tail(lines)) };
    return { detail: `${String(errors.length)} ${pluralErrors(errors.length)}`, problems: capProblems(errors) };
  }

  if (id === "lint") {
    const problems = [];
    let header = "";
    for (const raw of stripAnsi(output).split(/\r?\n/)) {
      const message = /^\s+(\d+):(\d+)\s+error\s+(.*\S)\s*$/.exec(raw);
      if (message) {
        problems.push(`${header}:${message[1]}:${message[2]} ${message[3]}`);
      } else if (raw.trim() !== "" && !/^\s/.test(raw) && !raw.startsWith("✖")) {
        header = raw.trim();
      }
    }
    if (problems.length === 0) return { detail: undefined, problems: capProblems(tail(lines)) };
    return { detail: `${String(problems.length)} ${pluralErrors(problems.length)}`, problems: capProblems(problems) };
  }

  const marked = lines.filter((line) => /ошибка|error/i.test(line));
  return { detail: undefined, problems: capProblems(marked.length > 0 ? marked : tail(lines)) };
}

/** `72_000` → «1 м 12 с»; меньше секунды — «< 1 с». */
export function formatDuration(ms) {
  if (ms < 1000) return "< 1 с";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)} с`;
  return `${String(Math.floor(seconds / 60))} м ${String(seconds % 60)} с`;
}

const PLATFORMS = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const pad = (value) => String(value).padStart(2, "0");

function formatWhen(date) {
  const day = `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${String(date.getUTCFullYear())}`;
  return `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

const cell = (text) => text.replace(/\|/g, "\\|");

function statusCell(result) {
  if (result.status === "ok") return "✅";
  const detail = result.detail === undefined || result.detail === "" ? "" : ` ${cell(result.detail)}`;
  return result.status === "fail" ? `❌${detail}` : `⏭${detail}`;
}

/**
 * Блок `## Проверено (pnpm verify)` для описания PR. Голова коммита и время
 * в шапке — чтобы по устаревшему отчёту было видно, что после него были
 * коммиты; ограждения кода нет, блок вставляется в описание как есть.
 */
export function buildReport({ head, dirty, when, platform, results }) {
  const platformName = PLATFORMS[platform] ?? platform;
  const headLine = `Голова: ${head.slice(0, 8)} · ${formatWhen(when)} · ${platformName}${dirty ? " · есть незакоммиченные правки" : ""}`;
  const rows = results.map((result) => {
    const time = result.ms === null || result.ms === undefined ? "—" : formatDuration(result.ms);
    return `| ${cell(result.label)} | ${statusCell(result)} | ${time} |`;
  });
  const lines = ["## Проверено (pnpm verify)", "", headLine, "", "| Шаг | Итог | Время |", "|---|---|---|", ...rows];

  const failedLines = results
    .filter((result) => result.status === "fail")
    .flatMap((result) => (result.problems ?? []).map((problem) => `- ${result.label}: ${problem}`));
  if (failedLines.length > 0) lines.push("", "Упало:", "", ...failedLines);
  return `${lines.join("\n")}\n`;
}

/** 0 — всё ✅ или ⏭; 1 — хоть один шаг красный. */
export function exitCodeOf(results) {
  return results.some((result) => result.status === "fail") ? 1 : 0;
}
