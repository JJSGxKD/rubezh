// Чистые части раскадровки эффектов (pnpm fx:frames, T-0213, Р142): разбор
// аргументов, план кадров и расчёт замеров по массивам чисел. Браузера здесь
// нет — обвязка в frames.mjs.

export const DEFAULT_BASE = "http://localhost:5173";
export const DEFAULT_OUT = "var/fx";
/** Кадр каждые 3 тика: 50 мс при 60 Гц. */
export const TICKS_PER_FRAME = 3;
export const FRAME_MS = 50;
/** Пиксель изменился, если какой-то канал ушёл больше чем на это. */
export const PIXEL_DELTA = 24;
/** Эффект «идёт», пока изменилось больше этой доли кадра. */
export const ACTIVE_SHARE = 0.005;
/** Сколько тихих кадров подряд считаются концом эффекта. */
export const QUIET_FRAMES = 3;
/** Скачок средней яркости больше этой доли от прошлого кадра — вспышка. */
export const FLASH_JUMP = 0.2;
/** Больше вспышек в секунду — порог светочувствительности WCAG 2.3.1. */
export const FLASH_PER_SECOND_LIMIT = 3;

const GROUNDS = { map: ["map"], light: ["light"], both: ["map", "light"] };
const BROWSERS = ["msedge", "chrome"];
const VALUE_FLAGS = ["--ground", "--base", "--out", "--browser"];

/**
 * Разбор командной строки. `catalog` — id сцен каталога; без него (null) имена
 * не проверяются, их проверит страница, когда отдаст каталог.
 */
export function parseArgs(argv, catalog, platform = process.platform) {
  const flags = {};
  const names = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      if (!VALUE_FLAGS.includes(arg)) throw new Error(`неизвестный флаг ${arg}`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`у флага ${arg} нет значения`);
      flags[arg] = value;
      i += 1;
    } else {
      names.push(arg);
    }
  }

  const ground = flags["--ground"] ?? "both";
  if (!(ground in GROUNDS)) throw new Error(`--ground: «${ground}» неизвестно, допустимо map, light или both`);
  const browser = flags["--browser"] ?? (platform === "win32" ? "msedge" : "chrome");
  if (!BROWSERS.includes(browser)) throw new Error(`--browser: «${browser}» неизвестно, допустимо msedge или chrome`);

  return {
    scenes: resolveScenes(names, catalog),
    grounds: GROUNDS[ground],
    browser,
    base: flags["--base"] ?? DEFAULT_BASE,
    out: flags["--out"] ?? DEFAULT_OUT,
  };
}

/** Без имён — все сцены каталога; неизвестное имя называется в ошибке. */
export function resolveScenes(names, catalog) {
  if (catalog === null) return names;
  for (const name of names) {
    if (!catalog.includes(name)) throw new Error(`сцены «${name}» нет, есть: ${catalog.join(", ")}`);
  }
  return names.length > 0 ? names : [...catalog];
}

/** Тики, на которых снимается кадр: нулевой и по одному на каждые три тика. */
export function framePlan(ticks) {
  const plan = [0];
  for (let tick = TICKS_PER_FRAME; tick <= ticks; tick += TICKS_PER_FRAME) plan.push(tick);
  return plan;
}

/** Доля пикселей RGBA, отличающихся больше чем на PIXEL_DELTA по любому каналу. */
export function changedShare(before, after) {
  const pixels = Math.floor(before.length / 4);
  if (pixels === 0 || after.length !== before.length) return 0;
  let changed = 0;
  for (let p = 0; p < pixels; p += 1) {
    const i = p * 4;
    if (
      Math.abs(before[i] - after[i]) > PIXEL_DELTA ||
      Math.abs(before[i + 1] - after[i + 1]) > PIXEL_DELTA ||
      Math.abs(before[i + 2] - after[i + 2]) > PIXEL_DELTA
    ) {
      changed += 1;
    }
  }
  return changed / pixels;
}

/** Средняя яркость кадра RGBA (по Rec. 601), 0…255. */
export function meanBrightness(rgba) {
  const pixels = Math.floor(rgba.length / 4);
  if (pixels === 0) return 0;
  let sum = 0;
  for (let p = 0; p < pixels; p += 1) {
    const i = p * 4;
    sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return sum / pixels;
}

/**
 * Сколько живёт эффект. `shares[i]` — доля изменившихся пикселей кадра i
 * против кадра i−1. Жизнь — от первого кадра выше порога до первого кадра,
 * после которого тихо QUIET_FRAMES кадров подряд.
 */
export function lifeMs(shares, frameMs = FRAME_MS) {
  const start = shares.findIndex((share) => share > ACTIVE_SHARE);
  if (start === -1) return { lifeMs: 0, note: null };
  for (let i = start; i + QUIET_FRAMES <= shares.length; i += 1) {
    let quiet = true;
    for (let k = 0; k < QUIET_FRAMES; k += 1) if (shares[i + k] > ACTIVE_SHARE) quiet = false;
    if (quiet) return { lifeMs: (i - start) * frameMs, note: null };
  }
  return { lifeMs: null, note: `не затух за ${(shares.length - 1) * frameMs} мс` };
}

/** Скачки средней яркости; предупреждение — больше FLASH_PER_SECOND_LIMIT в секунду. */
export function flashStats(brightness, frameMs = FRAME_MS) {
  const frames = [];
  for (let i = 1; i < brightness.length; i += 1) {
    const previous = brightness[i - 1];
    if (previous > 0 && Math.abs(brightness[i] - previous) / previous > FLASH_JUMP) frames.push(i);
  }
  const spanSec = ((brightness.length - 1) * frameMs) / 1000;
  const perSecond = spanSec > 0 ? frames.length / spanSec : 0;
  return { count: frames.length, frames, perSecond, warning: perSecond > FLASH_PER_SECOND_LIMIT ? "частые вспышки" : null };
}

/** 95-й процентиль по ближайшему рангу. */
export function percentile95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

/** Собирает замеры сцены из рядов, снятых на каждом кадре. */
export function summarize({ shares, brightness, objects, frameTimes }) {
  const life = lifeMs(shares);
  const flashes = flashStats(brightness);
  return {
    frames: shares.length,
    changedShare: { values: shares, max: Math.max(0, ...shares), mean: shares.length === 0 ? 0 : shares.reduce((a, b) => a + b, 0) / shares.length },
    lifeMs: life.lifeMs,
    lifeNote: life.note,
    flashes: { count: flashes.count, frames: flashes.frames, perSecond: flashes.perSecond, warning: flashes.warning },
    displayObjects: { values: objects, max: Math.max(0, ...objects.filter((v) => v !== null)) },
    frameTimeP95Ms: percentile95(frameTimes),
  };
}
