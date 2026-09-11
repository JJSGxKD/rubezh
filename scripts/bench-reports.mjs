#!/usr/bin/env node
/**
 * Сводка по отчётам FPS-испытаний: `pnpm reports`.
 *
 * Отчёт — это 18 КБ JSON с таймлайном, читать его глазами бессмысленно.
 * Скрипт показывает то, ради чего прогон и делался: какое устройство, сколько
 * врагов удержало и где сломалось. Подробности — в самом файле.
 *
 * Каталог берётся аргументом, а не из окружения: это отдельная утилита, а не
 * часть приложения, и лезть в конфигурацию бэкенда ей незачем.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STOP_LABELS = {
  duration: "по таймеру, предел не найден",
  degradation: "по подтверждённой просадке",
  pool_exhausted: "упёрлись в размер пула стенда",
  manual: "вручную",
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(process.argv[2] ?? join(repoRoot, "var/bench-reports"));

const entries = await readdir(directory).catch(() => null);
if (entries === null) {
  console.log(`Каталог ${directory} пуст или не существует — прогонов ещё не было.`);
  process.exit(0);
}

const reports = [];
for (const entry of entries) {
  if (!entry.endsWith(".json")) continue;
  reports.push(JSON.parse(await readFile(join(directory, entry), "utf8")));
}

if (reports.length === 0) {
  console.log(`В ${directory} нет отчётов.`);
  process.exit(0);
}

reports.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

console.log(`Отчёты испытаний: ${directory}\n`);
for (const record of reports) {
  const { report, verdict } = record;
  const { device, profile, totals } = report;
  const load =
    profile.mode !== "fixed"
      ? `ramp +${profile.addPerSecond}/с до ${profile.targetPopulation}`
      : `fixed ${profile.targetPopulation}`;

  console.log(
    `${record.receivedAt}  ${verdict.level.toUpperCase()}  ${record.reportId}  (${STOP_LABELS[report.stoppedBy] ?? "по таймеру"})`,
  );
  console.log(
    `  ${device.telegramPlatform ?? "вне Telegram"} ${device.telegramVersion ?? ""} | DPR ${device.devicePixelRatio} | канва ${profile.canvasWidth}x${profile.canvasHeight} | экран ${totals.displayHz ?? "?"} Гц | сборка ${profile.buildVersion}`,
  );
  console.log(`  ${shortDevice(device.userAgent)}`);
  console.log(
    `  ${load} | держит ${verdict.sustainedLoad} врагов | пик объектов ${Math.round(totals.peakObjects ?? totals.peakLoad)} (врагов ${Math.round(totals.peakLoad)}, снарядов ${Math.round(totals.peakProjectiles ?? 0)})`,
  );
  console.log(
    `  FPS ${totals.avgFps.toFixed(1)} (мин ${totals.minFps.toFixed(1)}) | p95 ${totals.p95FrameMs.toFixed(1)} мс | >33 мс ${(totals.over33Ratio * 100).toFixed(2)}% | деградация ${(totals.degradationRatio * 100).toFixed(2)}%`,
  );
  console.log(
    verdict.breakingPoint === null
      ? "  порог не пробит до конца прогона"
      : `  просадка на ${Math.round(verdict.breakingPoint.load)} врагах (${verdict.breakingPoint.atSec.toFixed(0)} с): FPS ${verdict.breakingPoint.avgFps.toFixed(1)}`,
  );
  if ((report.interruptions ?? 0) > 0) {
    console.log(`  ! прогон прерывался ${report.interruptions} раз (сворачивание) — цифры испорчены`);
  }
  for (const failure of verdict.failures) console.log(`  ! ${failure}`);
  console.log("");
}

/**
 * Из user-agent нужна модель устройства, а не строка на 200 символов.
 *
 * Первым проверяется хвост клиента Telegram: браузерная часть на Android
 * давно урезана до безликого «Android 11; K», а настоящая модель лежит
 * именно там — «Telegram-Android/12.10.1 (Tecno ... TECNO CH7n; ...)».
 */
function shortDevice(userAgent) {
  const telegramClient = /Telegram-\w+\/[\d.]+\s*\(([^;)]+)/.exec(userAgent);
  if (telegramClient !== null) return telegramClient[1].trim();

  const android = /Android[^;]*;\s*([^)]+?)\)/.exec(userAgent);
  if (android !== null) return android[1].trim();

  const parenthesised = /\(([^)]+)\)/.exec(userAgent);
  return parenthesised === null ? userAgent.slice(0, 60) : parenthesised[1];
}
