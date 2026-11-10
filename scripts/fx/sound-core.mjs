// Чистые части рендера звуков (pnpm fx:sound, T-0214, Р142): разбор аргументов,
// замеры, пометки по правилам грани (docs/31 §3, §8) и кодирование WAV.
// Браузера здесь нет — обвязка в sound.mjs.

import { DEFAULT_BASE, DEFAULT_OUT } from "./frames-core.mjs";

export { DEFAULT_BASE, DEFAULT_OUT };
export const SAMPLE_RATE = 48_000;
/** Ниже этого уровня звук считается тишиной. */
export const SILENCE_DBFS = -60;
export const HEADROOM_DBFS = -1;
/** Последние 5 мс громче этого — буфер оборван на звучащем месте. */
export const TAIL_WINDOW_MS = 5;
export const TAIL_CUT_DBFS = -40;
export const DC_LIMIT = 0.01;

const BROWSERS = ["msedge", "chrome"];
const VALUE_FLAGS = ["--variant", "--base", "--out", "--browser"];

/** `ids` — звуки каталога; null — не проверять (проверит страница). */
export function parseArgs(argv, ids, platform = process.platform) {
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
  const variant = flags["--variant"] ?? "first";
  if (variant !== "first" && variant !== "all") throw new Error(`--variant: «${variant}» неизвестно, допустимо first или all`);
  const browser = flags["--browser"] ?? (platform === "win32" ? "msedge" : "chrome");
  if (!BROWSERS.includes(browser)) throw new Error(`--browser: «${browser}» неизвестно, допустимо msedge или chrome`);
  return {
    sounds: resolveSounds(names, ids),
    variant,
    browser,
    base: flags["--base"] ?? DEFAULT_BASE,
    out: flags["--out"] ?? DEFAULT_OUT,
  };
}

export function resolveSounds(names, ids) {
  if (ids === null) return names;
  for (const name of names) {
    if (!ids.includes(name)) throw new Error(`звука «${name}» нет, есть: ${ids.join(", ")}`);
  }
  return names.length > 0 ? names : [...ids];
}

function toDb(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY;
}

/** Замеры одного отрисованного звука. */
export function measure(samples, sampleRate = SAMPLE_RATE) {
  const threshold = 10 ** (SILENCE_DBFS / 20);
  let peak = 0;
  let peakAt = 0;
  let first = -1;
  let last = -1;
  let clipped = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    const abs = Math.abs(value);
    sum += value;
    if (abs >= 1) clipped += 1;
    if (abs > peak) {
      peak = abs;
      peakAt = i;
    }
    if (abs > threshold) {
      if (first === -1) first = i;
      last = i;
    }
  }
  let rmsDbfs = Number.NEGATIVE_INFINITY;
  let audibleMs = 0;
  let tailMs = 0;
  if (first !== -1) {
    let squares = 0;
    for (let i = first; i <= last; i += 1) squares += samples[i] * samples[i];
    rmsDbfs = toDb(Math.sqrt(squares / (last - first + 1)));
    audibleMs = ((last - first + 1) / sampleRate) * 1000;
    tailMs = (Math.max(0, last - peakAt) / sampleRate) * 1000;
  }
  const endFrom = Math.max(0, samples.length - Math.round((sampleRate * TAIL_WINDOW_MS) / 1000));
  let endPeak = 0;
  for (let i = endFrom; i < samples.length; i += 1) endPeak = Math.max(endPeak, Math.abs(samples[i]));
  return {
    peakDbfs: toDb(peak),
    rmsDbfs,
    audibleMs,
    tailMs,
    clipped,
    dcOffset: samples.length > 0 ? sum / samples.length : 0,
    endPeakDbfs: toDb(endPeak),
    lengthMs: (samples.length / sampleRate) * 1000,
  };
}

function samplesWord(n) {
  const tens = n % 100;
  const ones = n % 10;
  if (ones === 1 && tens !== 11) return "отсчёт";
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return "отсчёта";
  return "отсчётов";
}

/**
 * Пометки: ошибка (код выхода 1), предупреждение (объяснить в PR) и заметка.
 * `recipe` — `gap`, `voices`, `dur` рецепта.
 */
export function findMarks(m, recipe) {
  const marks = [];
  if (m.peakDbfs < SILENCE_DBFS) {
    marks.push({ level: "error", text: "звук пустой: пик ниже −60 dBFS" });
    return marks;
  }
  if (m.clipped > 0) marks.push({ level: "error", text: `перегруз: ${m.clipped} ${samplesWord(m.clipped)}` });
  if (m.peakDbfs > HEADROOM_DBFS) marks.push({ level: "warning", text: "нет запаса до перегруза: пик выше −1 dBFS" });
  if (m.endPeakDbfs > TAIL_CUT_DBFS) marks.push({ level: "warning", text: "хвост обрезан — щелчок в конце: dur рецепта короче звука" });
  const limitMs = recipe.gap * recipe.voices * 1000;
  if (m.audibleMs > limitMs) {
    marks.push({ level: "warning", text: `звучит дольше, чем позволяют gap и voices (${Math.round(m.audibleMs)} мс при ${Math.round(limitMs)} мс): голоса будут гаситься` });
  }
  if (Math.abs(m.dcOffset) > DC_LIMIT) marks.push({ level: "warning", text: "смещение постоянной составляющей" });
  if (m.audibleMs < recipe.dur * 500) marks.push({ level: "note", text: "буфер вдвое длиннее звука — можно укоротить dur" });
  return marks;
}

/** WAV: RIFF, PCM 16 бит, моно. 1,0 → 32767, −1,0 → −32768. */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), 44 + i * 2);
  }
  return buffer;
}
