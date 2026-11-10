import { SOUND_RECIPES } from "../audio/recipes";
import type { SoundRecipe } from "../audio/recipes";
import { renderRecipe } from "../audio/synth";

/**
 * Страница рендера звуков (`?fx=sound`, `pnpm fx:sound`, docs/31 §8): тот же
 * синтез, что в игре, но сухой — без реверберации и шин: замеряется рецепт,
 * а не микс. Скрипт берёт отсчёты и спектрограмму через `window.__fxSound`,
 * замеры считает сам. Подключается только на dev-сервере (index.tsx).
 */
export const SOUND_RATE = 48_000;

const WINDOW = 1024;
const HOP = 256;
const FREQ_MIN = 50;
const FREQ_MAX = 20_000;
const DB_FLOOR = -90;
const WIDTH = 512;
const HEIGHT = 256;
const MARGIN_LEFT = 36;
const MARGIN_BOTTOM = 16;

export interface SoundCatalogEntry {
  id: string;
  bus: string;
  gap: number;
  voices: number;
  dur: number;
  variants: number;
}

export interface RenderedSound {
  id: string;
  variant: number;
  samples: number[];
  /** `data:image/png;base64,…` */
  spectrogramPng: string;
}

export type VariantMode = "first" | "all";

export interface FxSound {
  catalog: SoundCatalogEntry[];
  render(ids?: string[], variants?: VariantMode): Promise<RenderedSound[]>;
}

declare global {
  interface Window {
    __fxSound?: FxSound;
  }
}

/** Окно Ханна (периодическое, для спектров): в начале ровно 0, в середине 1. */
export function hann(size: number): Float64Array {
  const out = new Float64Array(size);
  for (let i = 0; i < size; i += 1) out[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return out;
}

/** БПФ radix-2 на месте; длина — степень двойки. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] ?? 0, re[i] ?? 0];
      [im[i], im[j]] = [im[j] ?? 0, im[i] ?? 0];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = start + k;
        const b = a + len / 2;
        const bRe = (re[b] ?? 0) * curRe - (im[b] ?? 0) * curIm;
        const bIm = (re[b] ?? 0) * curIm + (im[b] ?? 0) * curRe;
        re[b] = (re[a] ?? 0) - bRe;
        im[b] = (im[a] ?? 0) - bIm;
        re[a] = (re[a] ?? 0) + bRe;
        im[a] = (im[a] ?? 0) + bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Кадры спектра в дБ от полной шкалы: `frames[кадр][корзина]`. */
function spectrum(samples: Float32Array): Float64Array[] {
  const window = hann(WINDOW);
  let windowSum = 0;
  for (const w of window) windowSum += w;
  const reference = windowSum / 2; // амплитуда полношкального синуса после окна
  const count = Math.max(1, Math.floor((samples.length - WINDOW) / HOP) + 1);
  const frames: Float64Array[] = [];
  for (let f = 0; f < count; f += 1) {
    const re = new Float64Array(WINDOW);
    const im = new Float64Array(WINDOW);
    for (let i = 0; i < WINDOW; i += 1) re[i] = (samples[f * HOP + i] ?? 0) * (window[i] ?? 0);
    fft(re, im);
    const bins = new Float64Array(WINDOW / 2);
    for (let k = 0; k < bins.length; k += 1) {
      const magnitude = Math.hypot(re[k] ?? 0, im[k] ?? 0) / reference;
      bins[k] = magnitude > 0 ? Math.max(DB_FLOOR, Math.min(0, 20 * Math.log10(magnitude))) : DB_FLOOR;
    }
    frames.push(bins);
  }
  return frames;
}

/** Спектрограмма 512×256: частота по оси логарифмическая, яркость — дБ. */
function drawSpectrogram(samples: Float32Array, rate: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("нет 2d-контекста для спектрограммы");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const plotW = WIDTH - MARGIN_LEFT;
  const plotH = HEIGHT - MARGIN_BOTTOM;
  const frames = spectrum(samples);
  const image = ctx.createImageData(plotW, plotH);
  const binHz = rate / WINDOW;
  const ratio = FREQ_MAX / FREQ_MIN;
  for (let x = 0; x < plotW; x += 1) {
    const frame = Math.min(frames.length - 1, Math.max(0, Math.round(((x / plotW) * samples.length - WINDOW / 2) / HOP)));
    const bins = frames[frame];
    if (bins === undefined) continue;
    for (let y = 0; y < plotH; y += 1) {
      const frequency = FREQ_MIN * ratio ** (1 - y / (plotH - 1));
      const bin = Math.min(bins.length - 1, Math.round(frequency / binHz));
      const level = (((bins[bin] ?? DB_FLOOR) - DB_FLOOR) / -DB_FLOOR) * 255;
      const o = (y * plotW + x) * 4;
      image.data[o] = level;
      image.data[o + 1] = level * level / 255;
      image.data[o + 2] = 255 - level;
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, MARGIN_LEFT, 0);

  ctx.fillStyle = "#fff";
  ctx.font = "10px sans-serif";
  ctx.textBaseline = "middle";
  for (const [label, hz] of [["10k", 10_000], ["1k", 1_000], ["100", 100]] as const) {
    ctx.fillText(label, 2, (1 - Math.log(hz / FREQ_MIN) / Math.log(ratio)) * (plotH - 1));
  }
  ctx.textBaseline = "alphabetic";
  ctx.fillText("0", MARGIN_LEFT, HEIGHT - 3);
  const lengthLabel = `${Math.round((samples.length / rate) * 1000)} мс`;
  ctx.fillText(lengthLabel, WIDTH - ctx.measureText(lengthLabel).width - 2, HEIGHT - 3);
  return canvas.toDataURL("image/png");
}

function entries(): Array<[string, SoundRecipe]> {
  return Object.entries(SOUND_RECIPES as Record<string, SoundRecipe>);
}

export function startFxSound(): void {
  const catalog = entries().map(([id, recipe]) => ({ id, bus: recipe.bus, gap: recipe.gap, voices: recipe.voices, dur: recipe.dur, variants: recipe.variants }));
  window.__fxSound = {
    catalog,
    async render(ids, variants = "first") {
      const recipes = new Map(entries());
      const out: RenderedSound[] = [];
      for (const id of ids ?? catalog.map((entry) => entry.id)) {
        const recipe = recipes.get(id);
        if (recipe === undefined) throw new Error(`звука «${id}» нет в рецептах`);
        const count = variants === "all" ? Math.max(1, recipe.variants) : 1;
        for (let variant = 0; variant < count; variant += 1) {
          const buffer = await renderRecipe(SOUND_RATE, recipe, variant);
          const samples = buffer.getChannelData(0);
          out.push({ id, variant, samples: Array.from(samples), spectrogramPng: drawSpectrogram(samples, SOUND_RATE) });
        }
      }
      return out;
    },
  };
}
