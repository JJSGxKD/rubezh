// Единая проверка звука и эффектов: pnpm fx:check [--scenes a,b] [--sounds x,y]
// [--changed] [--base ветка] [--url адрес] [--out var/fx] [--browser …] (T-0215, Р142).
// Те же функции запуска, что у fx:frames и fx:sound. Нужен запущенный `pnpm dev`
// с VITE_DEV_TOOLS=1. В гейт CI не входит.

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, exitCode, parseArgs, selectByDiff } from "./check-core.mjs";
import { run as runFrames } from "./frames.mjs";
import { run as runSound } from "./sound.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

function changedFiles(base) {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
  return out.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/** Дата и время по Москве для заголовка отчёта. */
function moscowNow() {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" }).format(new Date()) + " МСК";
}

/** Запуск; возвращает код выхода. */
export async function run(options, log = console.log) {
  let runScenes = options.runScenes;
  let runSounds = options.runSounds;
  if (options.changed) {
    let files;
    try {
      files = changedFiles(options.diffBase);
    } catch (error) {
      log(`не удалось получить дифф с ${options.diffBase}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      return 1;
    }
    const picked = selectByDiff(files);
    runScenes = runScenes && picked.scenes;
    runSounds = runSounds && picked.sounds;
    if (!runScenes && !runSounds) {
      log("Звук и эффекты не менялись");
      return 0;
    }
  }

  const result = { scenes: [], sounds: [], files: [] };
  let failed = false;
  if (runScenes) {
    const code = await runFrames({ scenes: options.scenes, grounds: ["map", "light"], browser: options.browser, base: options.base, out: options.out }, log, result);
    if (code !== 0) failed = true;
  }
  if (runSounds) {
    const code = await runSound({ sounds: options.sounds, variant: "first", browser: options.browser, base: options.base, out: options.out }, log, result);
    if (code !== 0) failed = true;
  }

  await mkdir(options.out, { recursive: true });
  const files = result.files.map((file) => relative(ROOT, resolve(file)).replaceAll("\\", "/"));
  const reportPath = join(options.out, "report.md");
  await writeFile(reportPath, buildReport({ ...result, files }, moscowNow()));
  log(`\nотчёт ${reportPath}`);
  // Сбой запуска (нет клиента, браузера) — тоже красный код, но без отчёта о замерах он ничего не доказывает.
  return failed ? 1 : exitCode(result);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), null, null);
  } catch (error) {
    console.error(`pnpm fx:check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  process.exitCode = await run(options);
}
