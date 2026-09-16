#!/usr/bin/env node
/**
 * Повтор забега тестера по записи (docs/28-diagnostics.md §3.4):
 *
 *   pnpm replay <reportId> --from <diagnostic_reports.ndjson | отчёт.json>
 *
 * Отчёт берётся из выгрузки (`pnpm closed-test:export` или архив из бота,
 * распакованный): эндпоинтов чтения в проде нет. Скрипт находит запись,
 * сверяет контент текущего кода с контентом записи, прогоняет симуляцию
 * headless и сравнивает исход до свёртки мира.
 *
 * Коды выхода: 0 — повтор совпал; 1 — разошёлся при том же контенте, это
 * дефект детерминизма; 2 — повторить нельзя (другой контент, запись
 * неповторима или битая, отчёта нет, неверные аргументы).
 *
 * Исходники движка — TypeScript; их грузит `runnerImport` Vite, который и так
 * стоит в репозитории: отдельный загрузчик TS ради одного скрипта не нужен.
 */
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECORDING_SCHEMA = "rubezh.run.v1";

export const EXIT = { match: 0, mismatch: 1, cannot: 2 };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`Повтор упал: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exitCode = EXIT.cannot;
    },
  );
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args === null) {
    console.error("Использование: pnpm replay <reportId> --from <diagnostic_reports.ndjson | отчёт.json>");
    return EXIT.cannot;
  }

  const found = await findReport(resolve(process.cwd(), args.from), args.reportId);
  if (found === null) {
    console.error(`Записи забега ${args.reportId} в ${args.from} нет. Отчёт стресс-теста не повторяется — только запись забега.`);
    return EXIT.cannot;
  }

  const { runnerImport } = await import("vite");
  const load = async (path) =>
    (await runnerImport(join(repoRoot, path), { configFile: false, root: repoRoot, logLevel: "silent" })).module;
  const { replayRecording } = await load("packages/core-game/src/game/diagnostics/replay.ts");
  const { CONTENT_HASH } = await load("packages/core-game/src/content/hash.ts");

  console.log(describeRecording(found));
  const versionHint = versionMismatch(found.appVersion);
  if (versionHint !== null) console.log(versionHint);

  const outcome = replayRecording(found.recording, CONTENT_HASH);
  console.log(describeOutcome(outcome));
  return exitCodeOf(outcome.verdict);
}

export function parseArgs(argv) {
  let reportId = null;
  let from = null;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--") continue;
    if (value === "--from") {
      from = argv[++i] ?? null;
      continue;
    }
    if (value.startsWith("--from=")) {
      from = value.slice("--from=".length);
      continue;
    }
    if (reportId === null && !value.startsWith("--")) reportId = value;
  }
  return reportId === null || from === null || from === "" ? null : { reportId, from };
}

/**
 * Запись из файла. Понимает строки выгрузки (`diagnostic_reports.ndjson`),
 * конверт отчёта в том виде, в каком его шлёт оболочка, и голую запись.
 * Файл — граница: форма проверяется, а битая строка не роняет поиск.
 */
export async function findReport(path, reportId) {
  if (path.endsWith(".ndjson")) {
    const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      // Строки выгрузки весят десятки килобайт: разбираем только подходящие.
      if (!line.includes(reportId)) continue;
      const found = reportOf(safeJson(line), reportId);
      if (found !== null) return found;
    }
    return null;
  }
  return reportOf(safeJson(await readFile(path, "utf8")), reportId);
}

export function reportOf(value, reportId) {
  if (!isObject(value)) return null;
  const payload = isObject(value.payload) ? value.payload : value;
  const recording = isObject(payload.recording) ? payload.recording : value;
  if (!isObject(recording) || recording.schema !== RECORDING_SCHEMA || recording.reportId !== reportId) return null;
  const appVersion = typeof value.app_version === "string" ? value.app_version : typeof value.appVersion === "string" ? value.appVersion : null;
  const client = isObject(payload.client) ? payload.client : null;
  return { recording, appVersion, client };
}

export function exitCodeOf(verdict) {
  if (verdict === "match") return EXIT.match;
  if (verdict === "mismatch") return EXIT.mismatch;
  return EXIT.cannot;
}

export function describeRecording({ recording, appVersion, client }) {
  const result = recording.result;
  const end = recording.outcome === "died" ? `погиб${result.deathCause === null ? "" : ` от ${result.deathCause}`}` : "сдался";
  const lines = [
    `Запись ${recording.reportId}: сборка ${appVersion ?? "?"}, контент ${recording.contentHash}`,
    `  seed ${recording.seed}, карта ${recording.mapId}, сложность ${recording.difficultyId}, оружие ${recording.startingWeaponId}`,
    `  ${formatTime(result.survivalSec)}, уровень ${result.level}, убийств ${result.enemiesKilled}, ${end}`,
  ];
  if (client !== null && typeof client.clientErrors === "number" && client.clientErrors > 0) {
    lines.push(`  ошибок клиента за забег: ${client.clientErrors}`);
  }
  return lines.join("\n");
}

export function describeOutcome(outcome) {
  const { expected, actual } = outcome;
  switch (outcome.verdict) {
    case "match":
      return `Повтор совпал: ${expected.ticks} тиков, свёртка мира ${expected.checksum}.`;
    case "not_replayable":
      return `Запись не повторить: ${BLOCKERS[outcome.reason] ?? outcome.reason}.`;
    case "content_mismatch":
      return `Контент другой (${outcome.reason}). Переключитесь на тег сборки из записи и повторите.`;
    case "broken":
      return `Запись битая: ${outcome.reason}.`;
    default: {
      const where = outcome.divergedAtTick === null ? "" : ` на тике ${outcome.divergedAtTick} (${formatTime(outcome.divergedAtTick / 60)})`;
      const rows = actual === null ? [] : compareRows(expected, actual);
      return [
        `Повтор РАЗОШЁЛСЯ${where}: ${outcome.reason}.`,
        "При том же контенте это дефект детерминизма — он важнее исходного баг-репорта.",
        ...rows,
      ].join("\n");
    }
  }
}

const BLOCKERS = {
  resumed: "забег продолжен из снимка, лог ввода начинается с середины",
  dev: "забег разработчика — читы и команды в лог не пишутся",
  input_overflow: "лог ввода не влез в потолок",
};

function compareRows(expected, actual) {
  const fields = ["ticks", "survivalSec", "level", "enemiesKilled", "deathCause", "checksum"];
  return fields.map((field) => {
    const same = expected[field] === actual[field];
    return `  ${same ? " " : "≠"} ${field.padEnd(14)} запись ${String(expected[field]).padStart(12)}   повтор ${String(actual[field]).padStart(12)}`;
  });
}

function versionMismatch(appVersion) {
  if (appVersion === null) return null;
  let current;
  try {
    current = execFileSync("git", ["describe", "--tags", "--always"], { cwd: repoRoot, encoding: "utf8", timeout: 5_000 }).trim();
  } catch (error) {
    return `Версию кода не узнать (${error instanceof Error ? error.message : String(error)}); сверяется только контент.`;
  }
  return current === `v${appVersion}` || current === appVersion
    ? null
    : `Код сейчас ${current}, запись снята на ${appVersion}. Контент сверяется ниже; если разойдётся — git switch --detach v${appVersion}.`;
}

function formatTime(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
