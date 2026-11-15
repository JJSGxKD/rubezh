// Чистые части единой проверки звука и эффектов (pnpm fx:check, T-0215, Р142):
// разбор аргументов, выбор по диффу и сборка отчёта. Браузера и git здесь нет —
// обвязка в check.mjs.

import { DEFAULT_BASE, DEFAULT_OUT, resolveScenes } from "./frames-core.mjs";
import { resolveSounds } from "./sound-core.mjs";

const BROWSERS = ["msedge", "chrome"];
const VALUE_FLAGS = ["--scenes", "--sounds", "--base", "--url", "--out", "--browser"];
const BOOL_FLAGS = ["--changed"];

const SOUND_FILES = ["packages/app-shell/src/audio/recipes.ts", "packages/app-shell/src/audio/synth.ts"];
const SCENE_FILES = ["packages/core-game/src/content/weapons.ts"];
const SCENE_DIR = "packages/core-game/src/game/render/";

const splitList = (value) => value.split(",").map((item) => item.trim()).filter((item) => item !== "");

/**
 * Разбор командной строки. Каталоги (id сцен и звуков) — для проверки имён;
 * null — не проверять, проверит страница стенда.
 * Флаг `--scenes` или `--sounds` ограничивает проверку названным; без них — всё.
 */
export function parseArgs(argv, sceneCatalog, soundCatalog, platform = process.platform) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (BOOL_FLAGS.includes(arg)) {
      flags[arg] = true;
    } else if (VALUE_FLAGS.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`у флага ${arg} нет значения`);
      flags[arg] = value;
      i += 1;
    } else {
      throw new Error(`неизвестный аргумент ${arg}`);
    }
  }
  const browser = flags["--browser"] ?? (platform === "win32" ? "msedge" : "chrome");
  if (!BROWSERS.includes(browser)) throw new Error(`--browser: «${browser}» неизвестно, допустимо msedge или chrome`);

  const sceneNames = flags["--scenes"] === undefined ? [] : splitList(flags["--scenes"]);
  const soundNames = flags["--sounds"] === undefined ? [] : splitList(flags["--sounds"]);
  const explicit = flags["--scenes"] !== undefined || flags["--sounds"] !== undefined;
  return {
    scenes: resolveScenes(sceneNames, sceneCatalog),
    sounds: resolveSounds(soundNames, soundCatalog),
    // Явный список одной стороны не тянет за собой другую.
    runScenes: !explicit || flags["--scenes"] !== undefined,
    runSounds: !explicit || flags["--sounds"] !== undefined,
    changed: flags["--changed"] === true,
    diffBase: flags["--base"] ?? "origin/dev",
    browser,
    base: flags["--url"] ?? DEFAULT_BASE,
    out: flags["--out"] ?? DEFAULT_OUT,
  };
}

/** Что проверять по списку изменённых файлов ветки. */
export function selectByDiff(files) {
  const normalized = files.map((file) => file.replaceAll("\\", "/"));
  return {
    scenes: normalized.some((file) => SCENE_FILES.includes(file) || file.startsWith(SCENE_DIR)),
    sounds: normalized.some((file) => SOUND_FILES.includes(file)),
  };
}

/** Ошибки: у звука — пометки уровня error, у эффекта — «частые вспышки». */
export function collectProblems(result) {
  const errors = [];
  const warnings = [];
  for (const item of result.scenes) {
    const name = `${item.scene}-${item.ground}`;
    if (item.flashes.warning !== null) errors.push(`${name}: ${item.flashes.warning}`);
    if (item.lifeNote !== null) warnings.push(`${name}: ${item.lifeNote}`);
  }
  for (const item of result.sounds) {
    const name = `${item.id}-${item.variant}`;
    for (const mark of item.marks) {
      if (mark.level === "error") errors.push(`${name}: ${mark.text}`);
      else if (mark.level === "warning") warnings.push(`${name}: ${mark.text}`);
    }
  }
  return { errors, warnings };
}

/** 1 — ошибка звука или частые вспышки; иначе 0. */
export function exitCode(result) {
  return collectProblems(result).errors.length > 0 ? 1 : 0;
}

const num = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : "−∞");
const cell = (text) => String(text).replaceAll("|", "\\|");

function marksText(marks) {
  return marks.length === 0 ? "—" : marks.map((mark) => `${mark.level === "error" ? "ОШИБКА" : mark.level === "warning" ? "!" : "·"} ${mark.text}`).join("; ");
}

/** Отчёт для описания PR. `date` — уже отформатированная дата по Москве. */
export function buildReport(result, date) {
  const { errors, warnings } = collectProblems(result);
  const lines = ["## Звук и эффекты", "", `\`pnpm fx:check --changed\`, ${date}`, ""];
  lines.push(errors.length > 0 ? `Ошибки: ${errors.join("; ")}` : "Ошибок нет");
  if (warnings.length > 0) lines.push("", `Предупреждения: ${warnings.join("; ")}`);

  if (result.scenes.length > 0) {
    lines.push("", "### Эффекты", "");
    lines.push("| Сцена | Земля | lifeMs | Макс. доля экрана | Вспышек в секунду | Макс. объектов | p95 кадра |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    for (const m of result.scenes) {
      const life = m.lifeMs === null ? "—" : String(m.lifeMs);
      const notes = [m.flashes.warning, m.lifeNote].filter((note) => note !== null && note !== undefined);
      const flashes = `${num(m.flashes.perSecond)}${m.flashes.warning === null ? "" : " (!)"}`;
      const p95 = m.frameTimeP95Ms === null ? "—" : num(m.frameTimeP95Ms);
      const scene = notes.length > 0 ? `${m.scene} (${notes.join(", ")})` : m.scene;
      lines.push(`| ${cell(scene)} | ${m.ground} | ${life} | ${num(m.changedShare.max * 100)}% | ${flashes} | ${m.displayObjects.max} | ${p95} |`);
    }
  }

  if (result.sounds.length > 0) {
    lines.push("", "### Звуки", "");
    lines.push("| Звук | Шина | Пик, dBFS | Громкость (RMS), dBFS | Длина, мс | Хвост, мс | Пометки |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | --- |");
    for (const s of result.sounds) {
      lines.push(`| ${cell(`${s.id}-${s.variant}`)} | ${s.bus} | ${num(s.peakDbfs)} | ${num(s.rmsDbfs)} | ${num(s.audibleMs, 0)} | ${num(s.tailMs, 0)} | ${cell(marksText(s.marks))} |`);
    }
  }

  if (result.files.length > 0) {
    lines.push("", "### Файлы", "");
    for (const file of result.files) lines.push(`- \`${file}\``);
  }
  return `${lines.join("\n")}\n`;
}
