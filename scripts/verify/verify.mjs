#!/usr/bin/env node
// pnpm verify (T-0474, docs/35-stage4-plan.md Р224, B): гейт по затронутым
// пакетам и отчёт для описания PR, который пишет скрипт, а не агент.
//
//   pnpm verify                      отчёт — в stdout
//   pnpm verify --write verify.md    отчёт — в файл (var/ в git не попадает)
//   pnpm verify --db                 ещё и интеграция с базой (TEST_DATABASE_URL на rubezh_test)
//   pnpm verify --base <ветка>       с чем сравнивать дифф (по умолчанию origin/dev)
//
// Код выхода — 0, только если нет ни одного ❌. Полный `pnpm test` остаётся
// за CI: на общей машине он слишком долог.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReport, exitCodeOf, formatDuration, planSteps, runPlan } from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE = `Использование: pnpm verify [--write <файл>] [--db] [--base <ветка>]`;
const MAX_BUFFER = 256 * 1024 * 1024;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  const flags = { db: false, write: null, base: "origin/dev", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") flags.db = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--write" || arg === "--base") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg}: нужно значение.\n${USAGE}`);
      flags[arg.slice(2)] = value;
      index += 1;
    } else fail(`Неизвестный аргумент «${arg}».\n${USAGE}`);
  }
  return flags;
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const lines = (text) => (text === "" ? [] : text.split(/\r?\n/));

/** Файлы PR: коммиты ветки от развилки с базой и ещё не закоммиченные правки отслеживаемых файлов. */
function changedFiles(base) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  } catch {
    fail(`Нет ветки «${base}»: выполни git fetch origin или укажи --base.`);
  }
  const committed = lines(git(["diff", "--name-only", "--no-renames", `${base}...HEAD`]));
  const working = lines(git(["diff", "--name-only", "--no-renames", "HEAD"]));
  return [...new Set([...committed, ...working])];
}

/** Пакеты монорепо: каталоги с `package.json` (кроме корня) и их зависимости друг от друга. */
function workspace() {
  const manifests = lines(git(["ls-files", "--", "*package.json"])).filter((path) => path.endsWith("/package.json"));
  const parsed = manifests.map((path) => ({ dir: dirname(path), json: JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) }));
  const dirByName = new Map(parsed.filter((pkg) => typeof pkg.json.name === "string").map((pkg) => [pkg.json.name, pkg.dir]));
  const graph = {};
  for (const pkg of parsed) {
    const names = ["dependencies", "devDependencies", "peerDependencies"].flatMap((field) => Object.keys(pkg.json[field] ?? {}));
    graph[pkg.dir] = names.map((name) => dirByName.get(name)).filter((dir) => dir !== undefined && dir !== pkg.dir);
  }
  return { dirs: parsed.map((pkg) => pkg.dir), graph };
}

const quote = (arg) => (/^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

/**
 * Запуск одной команды. Через оболочку: на Windows `pnpm` — это `pnpm.cmd`, а
 * Node без оболочки его не запускает. Таймаут убивает оболочку, но на Windows
 * внуки (vitest, tsc) могут дожить до конца своей работы — таймауты
 * поэтому щедрые, и срабатывают они только на зависании.
 */
function runCommand(command) {
  const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const name of command.unsetEnv) delete env[name];
  const line = [command.cmd, ...command.args.map(quote)].join(" ");
  const started = Date.now();
  const result = spawnSync(line, { cwd: ROOT, shell: true, encoding: "utf8", env, timeout: command.timeoutMs, maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
  const ms = Date.now() - started;
  const timedOut = result.error !== undefined && result.error.code === "ETIMEDOUT";
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}${result.error !== undefined && !timedOut ? `\n${result.error.message}` : ""}`;
  return { code: result.status, output, ms, timedOut };
}

function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }

  const files = changedFiles(flags.base);
  const { dirs, graph } = workspace();
  const plan = planSteps({ files, dirs, graph, db: flags.db, env: process.env, exists: (path) => existsSync(resolve(ROOT, path)), base: flags.base });

  const head = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]) !== "";
  console.error(`pnpm verify: ${String(files.length)} файлов в диффе с ${flags.base}, голова ${head.slice(0, 8)}`);

  const results = runPlan(plan, (command, step) => {
    console.error(`→ ${step.label} …`);
    const outcome = runCommand(command);
    console.error(`  ${outcome.code === 0 && !outcome.timedOut ? "ок" : "красный"}, ${formatDuration(outcome.ms)}`);
    return outcome;
  });

  const report = buildReport({ head, dirty, when: new Date(), platform: process.platform, results });
  if (flags.write === null) {
    process.stdout.write(report);
  } else {
    const target = resolve(process.cwd(), flags.write);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, report, "utf8");
    console.error(`Отчёт записан: ${target}`);
  }
  return exitCodeOf(results);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
