/**
 * Звуки игры и интерфейса — данными, а не кодом (docs/31-audio-and-haptics.md).
 *
 * Каждый звук — слои синтеза, отрисованные заранее в буфер: тон, шум через
 * фильтр, колокольчик, протяжный звук с фильтром. Данными — чтобы лаборатория
 * звука правила числа на горячую, а удачную правку можно было скопировать
 * сюда как есть.
 *
 * Шина — место звука в миксе. По шинам работают правила грани в движке:
 * бюджет запусков, прореживание частых звуков и приглушение под угрозу.
 */

export type BusId = "threats" | "player" | "rewards" | "weapons" | "enemies" | "ui" | "music";

/** Группа — то, чем управляет один регулятор громкости в настройках. */
export type BusGroup = "effects" | "ui" | "music";

export interface BusDef {
  /** уровень шины в миксе, 0…1 */
  level: number;
  /** угроза перекрывает всё, оружие — подложка, толпа режется первой */
  priority: number;
  /** куда шина идёт: регулятор эффектов, интерфейса или музыки */
  group: BusGroup;
}

export const BUSES: Record<BusId, BusDef> = {
  threats: { level: 0.9, priority: 3, group: "effects" },
  player: { level: 0.9, priority: 3, group: "effects" },
  rewards: { level: 0.8, priority: 2, group: "effects" },
  weapons: { level: 0.55, priority: 1, group: "effects" },
  enemies: { level: 0.5, priority: 0, group: "effects" },
  ui: { level: 0.8, priority: 2, group: "ui" },
  music: { level: 1, priority: 2, group: "music" },
};

/**
 * Правила грани: без них пять видов оружия и толпа сливаются в шум, а важное —
 * взрыв рядом, элита, попадание — тонет.
 */
export interface MixRules {
  /** сколько запусков в секунду получает шина, сколько бы событий ни случилось */
  budgetPerSec: Partial<Record<BusId, number>>;
  /** потолок одновременно звучащих голосов; сверх него режутся шины с приоритетом ниже двух */
  globalVoices: number;
  /** чем чаще звук, тем тише каждый запуск: делитель частоты и нижняя граница громкости */
  densitySoftness: number;
  densityFloor: number;
  /** до какой доли приглушается шина под звуком с `duck` */
  duckDepth: Partial<Record<BusId, number>>;
}

export const MIX_RULES: MixRules = {
  budgetPerSec: { weapons: 8, enemies: 9 },
  globalVoices: 20,
  densitySoftness: 3,
  densityFloor: 0.4,
  duckDepth: { music: 0.55, enemies: 0.4, weapons: 0.5, rewards: 0.5 },
};

export type SoundLayer =
  | {
      kind: "tone";
      wave?: OscillatorType;
      f0: number;
      f1?: number;
      glide?: number;
      t?: number;
      attack?: number;
      peak: number;
      decay: number;
      detune?: number;
    }
  | {
      kind: "hiss";
      filter?: BiquadFilterType;
      f0: number;
      f1?: number;
      glide?: number;
      q?: number;
      t?: number;
      dur: number;
      attack?: number;
      peak: number;
      decay?: number;
      seed: number;
    }
  | { kind: "bell"; f: number; t?: number; peak?: number; decay?: number; ratio?: number; index?: number }
  | {
      /** протяжный звук: подъём, удержание, спад, по желанию — фильтр с развёрткой и расстройка голосов */
      kind: "swell";
      wave?: OscillatorType;
      f0: number;
      f1?: number;
      glide?: number;
      t?: number;
      attack: number;
      hold?: number;
      release: number;
      peak: number;
      detune?: number[];
      filter?: { type: BiquadFilterType; f0: number; f1?: number; glide?: number; q?: number };
    };

export interface SoundRecipe {
  bus: BusId;
  /** громкость звука внутри шины */
  level: number;
  /** сколько экземпляров звучит одновременно; лишний гасится коротким спадом */
  voices: number;
  /** минимальный интервал между запусками, секунды */
  gap: number;
  /** доля в реверберацию */
  send: number;
  /** приглушить шины ниже по важности на столько секунд */
  duck?: number;
  /** длина буфера, секунды */
  dur: number;
  variants: number;
  /** множитель частот каждого варианта: один звук подряд не звучит одинаково */
  pitch?: number[];
  layers: SoundLayer[];
}

export type SoundId = keyof typeof SOUND_RECIPES;

export const SOUND_RECIPES = {
  // --- оружие: тихий слой, у каждого своя полоса частот ---------------------
  spark: {
    bus: "weapons", level: 0.42, voices: 2, gap: 0.07, send: 0.05, dur: 0.08, variants: 3, pitch: [1, 1.076, 0.933],
    layers: [
      { kind: "tone", f0: 2100, f1: 1155, glide: 0.03, peak: 0.24, decay: 0.045 },
      { kind: "hiss", dur: 0.02, seed: 3, filter: "highpass", f0: 6000, peak: 0.05, decay: 0.015 },
    ],
  },
  knife: {
    bus: "weapons", level: 0.45, voices: 2, gap: 0.08, send: 0.04, dur: 0.13, variants: 3, pitch: [1, 0.944, 0.889],
    layers: [{ kind: "hiss", dur: 0.11, seed: 11, f0: 2700, f1: 1100, glide: 0.08, q: 1.4, attack: 0.008, peak: 0.42, decay: 0.09 }],
  },
  wardstone: {
    bus: "weapons", level: 0.42, voices: 2, gap: 0.06, send: 0.08, dur: 0.08, variants: 3, pitch: [1, 1.083, 1.167],
    layers: [
      { kind: "tone", wave: "triangle", f0: 480, f1: 432, glide: 0.03, peak: 0.3, decay: 0.045 },
      { kind: "tone", f0: 1200, peak: 0.05, decay: 0.02 },
      { kind: "hiss", dur: 0.02, seed: 21, filter: "lowpass", f0: 1800, peak: 0.15, decay: 0.015 },
    ],
  },
  hearth: {
    bus: "weapons", level: 0.45, voices: 1, gap: 0.35, send: 0.12, dur: 0.42, variants: 2, pitch: [1, 0.94],
    layers: [
      { kind: "hiss", dur: 0.36, seed: 31, filter: "lowpass", f0: 380, f1: 180, glide: 0.3, attack: 0.05, peak: 0.36, decay: 0.3 },
      { kind: "tone", f0: 68, f1: 50, glide: 0.25, attack: 0.03, peak: 0.28, decay: 0.28 },
    ],
  },
  storm: {
    bus: "weapons", level: 0.62, voices: 1, gap: 0.4, send: 0.3, dur: 1.15, variants: 3, pitch: [1, 0.95, 1.05],
    layers: [
      { kind: "hiss", dur: 0.06, seed: 41, filter: "highpass", f0: 2000, peak: 0.75, decay: 0.04 },
      { kind: "hiss", dur: 0.24, seed: 44, f0: 1200, f1: 500, glide: 0.2, q: 0.6, peak: 0.4, decay: 0.2 },
      { kind: "hiss", t: 0.02, dur: 1, seed: 47, filter: "lowpass", f0: 240, f1: 110, glide: 0.8, attack: 0.03, peak: 0.55, decay: 0.85 },
      { kind: "tone", f0: 55, f1: 36, glide: 0.5, t: 0.01, attack: 0.02, peak: 0.4, decay: 0.5 },
    ],
  },

  // --- враги: фактура толпы, прореживается первой ---------------------------
  hit: {
    bus: "enemies", level: 0.34, voices: 3, gap: 0.04, send: 0, dur: 0.07, variants: 3, pitch: [1, 1.125, 0.896],
    layers: [
      { kind: "tone", f0: 240, f1: 130, glide: 0.04, peak: 0.32, decay: 0.045 },
      { kind: "hiss", dur: 0.025, seed: 51, f0: 1500, q: 2, peak: 0.12, decay: 0.02 },
    ],
  },
  popSmall: {
    bus: "enemies", level: 0.38, voices: 3, gap: 0.05, send: 0.04, dur: 0.1, variants: 4, pitch: [1, 1.12, 0.93, 1.24],
    layers: [
      { kind: "tone", f0: 820, f1: 262, glide: 0.05, peak: 0.26, decay: 0.07 },
      { kind: "hiss", dur: 0.03, seed: 61, f0: 2400, q: 1.2, peak: 0.14, decay: 0.025 },
    ],
  },
  popHeavy: {
    bus: "enemies", level: 0.5, voices: 2, gap: 0.1, send: 0.1, dur: 0.32, variants: 3, pitch: [1, 0.92, 0.85],
    layers: [
      { kind: "hiss", dur: 0.22, seed: 71, filter: "lowpass", f0: 900, f1: 250, glide: 0.18, peak: 0.5, decay: 0.2 },
      { kind: "tone", f0: 130, f1: 58, glide: 0.18, peak: 0.45, decay: 0.22 },
      { kind: "hiss", t: 0.03, dur: 0.12, seed: 74, f0: 380, f1: 1300, glide: 0.1, q: 3, peak: 0.1, decay: 0.1 },
    ],
  },

  // --- угрозы: слышны всегда, приглушают оружие и толпу ---------------------
  enemyShot: {
    bus: "threats", level: 0.42, voices: 2, gap: 0.1, send: 0.08, dur: 0.14, variants: 2, pitch: [1, 0.93],
    layers: [
      { kind: "tone", wave: "triangle", f0: 540, f1: 250, glide: 0.09, peak: 0.28, decay: 0.1 },
      { kind: "hiss", dur: 0.05, seed: 151, f0: 900, q: 1.5, peak: 0.14, decay: 0.04 },
    ],
  },
  dashWarn: {
    bus: "threats", level: 0.5, voices: 2, gap: 0.15, send: 0.1, duck: 0.55, dur: 0.6, variants: 1,
    layers: [
      { kind: "swell", wave: "sawtooth", f0: 88, attack: 0.35, release: 0.2, peak: 0.16, filter: { type: "lowpass", f0: 260, f1: 1000, glide: 0.48, q: 4 } },
    ],
  },
  dashGo: {
    bus: "threats", level: 0.5, voices: 2, gap: 0.1, send: 0.05, dur: 0.3, variants: 2, pitch: [1, 1.08],
    layers: [{ kind: "hiss", dur: 0.24, seed: 141, f0: 380, f1: 2600, glide: 0.18, q: 1.1, attack: 0.02, peak: 0.5, decay: 0.2 }],
  },
  fuseTick: {
    bus: "threats", level: 0.36, voices: 3, gap: 0.02, send: 0.05, duck: 0.3, dur: 0.06, variants: 1,
    layers: [{ kind: "tone", wave: "triangle", f0: 980, peak: 0.3, decay: 0.035 }],
  },
  blast: {
    bus: "threats", level: 0.6, voices: 2, gap: 0.08, send: 0.2, duck: 0.5, dur: 0.8, variants: 2, pitch: [1, 0.9],
    layers: [
      { kind: "hiss", dur: 0.6, seed: 131, filter: "lowpass", f0: 1300, f1: 260, glide: 0.45, peak: 0.7, decay: 0.55 },
      { kind: "tone", f0: 96, f1: 40, glide: 0.4, peak: 0.6, decay: 0.45 },
    ],
  },
  eliteHorn: {
    bus: "threats", level: 0.58, voices: 1, gap: 1, send: 0.55, duck: 1.4, dur: 2, variants: 1,
    layers: [
      { kind: "tone", f0: 62, f1: 40, glide: 0.4, peak: 0.5, decay: 0.5 },
      { kind: "swell", wave: "sawtooth", f0: 110, attack: 0.18, hold: 0.32, release: 0.25, peak: 0.13, detune: [0, 7], filter: { type: "lowpass", f0: 300, f1: 1300, glide: 0.25, q: 1.5 } },
      { kind: "swell", wave: "sawtooth", f0: 73.42, t: 0.55, attack: 0.18, hold: 0.5, release: 0.25, peak: 0.13, detune: [0, 7], filter: { type: "lowpass", f0: 300, f1: 1300, glide: 0.25, q: 1.5 } },
    ],
  },

  // --- персонаж ---------------------------------------------------------------
  hurt: {
    bus: "player", level: 0.55, voices: 1, gap: 0.18, send: 0.05, duck: 0.25, dur: 0.24, variants: 2, pitch: [1, 0.91],
    layers: [
      { kind: "tone", f0: 170, f1: 68, glide: 0.12, peak: 0.55, decay: 0.16 },
      { kind: "hiss", dur: 0.1, seed: 101, filter: "lowpass", f0: 1000, peak: 0.3, decay: 0.08 },
    ],
  },
  heartbeat: {
    bus: "player", level: 0.6, voices: 1, gap: 0.25, send: 0, dur: 0.5, variants: 1,
    layers: [
      { kind: "tone", f0: 64, f1: 46, glide: 0.1, peak: 0.7, decay: 0.12 },
      { kind: "hiss", dur: 0.06, seed: 111, filter: "lowpass", f0: 300, peak: 0.25, decay: 0.05 },
      { kind: "tone", t: 0.19, f0: 72, f1: 50, glide: 0.1, peak: 0.5, decay: 0.12 },
    ],
  },
  defeat: {
    bus: "player", level: 0.6, voices: 1, gap: 1, send: 0.55, duck: 2.5, dur: 2.2, variants: 1,
    layers: [
      { kind: "swell", wave: "triangle", f0: 329.63, f1: 319.8, glide: 0.5, attack: 0.02, release: 0.45, peak: 0.24, filter: { type: "lowpass", f0: 2000 } },
      { kind: "swell", wave: "triangle", f0: 261.63, f1: 253.8, glide: 0.5, t: 0.28, attack: 0.02, release: 0.45, peak: 0.24, filter: { type: "lowpass", f0: 1500 } },
      { kind: "swell", wave: "triangle", f0: 220, f1: 213.4, glide: 0.5, t: 0.56, attack: 0.02, release: 1.3, peak: 0.24, filter: { type: "lowpass", f0: 1000 } },
    ],
  },

  // --- награды: светлые колокольчики -----------------------------------------
  gem: {
    bus: "rewards", level: 0.4, voices: 4, gap: 0.03, send: 0.18, dur: 0.36, variants: 3, pitch: [1, 1.122, 1.26],
    layers: [{ kind: "bell", f: 1046.5, peak: 0.24, decay: 0.3, ratio: 3.5, index: 0.9 }],
  },
  heal: {
    bus: "rewards", level: 0.5, voices: 1, gap: 0.2, send: 0.45, dur: 1, variants: 1,
    layers: [
      { kind: "swell", f0: 392, f1: 784, glide: 0.32, attack: 0.06, release: 0.54, peak: 0.2 },
      { kind: "bell", f: 1568, t: 0.16, peak: 0.08, decay: 0.6, index: 0.5 },
      { kind: "bell", f: 2093, t: 0.26, peak: 0.06, decay: 0.6, index: 0.5 },
    ],
  },
  magnet: {
    bus: "rewards", level: 0.5, voices: 1, gap: 0.3, send: 0.4, dur: 1.1, variants: 1,
    layers: [{ kind: "swell", wave: "triangle", f0: 170, f1: 1100, glide: 0.42, attack: 0.05, release: 0.5, peak: 0.2 }],
  },
  dynamite: {
    bus: "rewards", level: 0.78, voices: 1, gap: 0.3, send: 0.3, duck: 1, dur: 1.9, variants: 1,
    layers: [
      { kind: "hiss", dur: 0.12, seed: 121, filter: "highpass", f0: 4000, attack: 0.03, peak: 0.12, decay: 0.08 },
      { kind: "hiss", t: 0.1, dur: 0.06, seed: 122, filter: "highpass", f0: 1500, peak: 0.9, decay: 0.04 },
      { kind: "hiss", t: 0.1, dur: 1.5, seed: 123, filter: "lowpass", f0: 1900, f1: 160, glide: 1.1, attack: 0.01, peak: 0.85, decay: 1.35 },
      { kind: "tone", t: 0.1, f0: 72, f1: 27, glide: 0.8, attack: 0.01, peak: 0.85, decay: 1 },
    ],
  },
  eliteDown: {
    bus: "rewards", level: 0.62, voices: 1, gap: 0.3, send: 0.45, duck: 0.8, dur: 1.5, variants: 1,
    layers: [
      { kind: "hiss", dur: 0.7, seed: 91, filter: "lowpass", f0: 1400, f1: 180, glide: 0.6, peak: 0.6, decay: 0.65 },
      { kind: "tone", f0: 90, f1: 38, glide: 0.5, peak: 0.55, decay: 0.6 },
      { kind: "bell", f: 880, t: 0.12, peak: 0.1, decay: 0.9, index: 0.6 },
      { kind: "bell", f: 1318.5, t: 0.18, peak: 0.1, decay: 0.9, index: 0.6 },
      { kind: "bell", f: 1760, t: 0.24, peak: 0.1, decay: 0.9, index: 0.6 },
    ],
  },
  levelUp: {
    bus: "rewards", level: 0.58, voices: 1, gap: 0.5, send: 0.5, duck: 1.4, dur: 1.8, variants: 1,
    layers: [587.33, 739.99, 880, 1174.66].map((f, i) => ({ kind: "bell" as const, f, t: i * 0.075, peak: 0.2, decay: 0.7, index: 0.8 })),
  },
  choose: {
    bus: "rewards", level: 0.5, voices: 1, gap: 0.2, send: 0.35, dur: 0.7, variants: 1,
    layers: [
      { kind: "bell", f: 880, peak: 0.2, decay: 0.35, index: 0.7 },
      { kind: "bell", f: 1174.66, t: 0.085, peak: 0.22, decay: 0.45, index: 0.7 },
    ],
  },
  record: {
    bus: "rewards", level: 0.6, voices: 1, gap: 1, send: 0.5, duck: 2, dur: 2, variants: 1,
    layers: [
      ...[587.33, 880, 1174.66, 1479.98].map((f, i) => ({ kind: "bell" as const, f, t: i * 0.1, peak: 0.2, decay: 0.5, index: 0.8 })),
      ...[587.33, 739.99, 880, 1174.66].map((f) => ({ kind: "bell" as const, f, t: 0.46, peak: 0.1, decay: 1.4, index: 0.5 })),
    ],
  },

  // --- интерфейс: тихо, коротко, только на значимые касания -------------------
  uiTap: {
    bus: "ui", level: 0.5, voices: 2, gap: 0.04, send: 0, dur: 0.05, variants: 1,
    layers: [{ kind: "tone", f0: 1700, f1: 1300, glide: 0.015, peak: 0.12, decay: 0.025 }],
  },
  uiBack: {
    bus: "ui", level: 0.5, voices: 2, gap: 0.04, send: 0, dur: 0.05, variants: 1,
    layers: [{ kind: "tone", f0: 1300, f1: 900, glide: 0.02, peak: 0.1, decay: 0.03 }],
  },
  uiPress: {
    bus: "ui", level: 0.55, voices: 1, gap: 0.08, send: 0.15, dur: 0.28, variants: 1,
    layers: [
      { kind: "tone", wave: "triangle", f0: 440, f1: 400, glide: 0.02, peak: 0.24, decay: 0.06 },
      { kind: "bell", f: 880, t: 0.01, peak: 0.07, decay: 0.2, index: 0.4 },
    ],
  },
  uiSelect: {
    bus: "ui", level: 0.5, voices: 2, gap: 0.05, send: 0.1, dur: 0.2, variants: 3, pitch: [1, 1.122, 1.26],
    layers: [
      { kind: "tone", f0: 1500, f1: 1200, glide: 0.015, peak: 0.08, decay: 0.02 },
      { kind: "bell", f: 1174.66, t: 0.01, peak: 0.07, decay: 0.15, index: 0.4 },
    ],
  },
  uiToggleOn: {
    bus: "ui", level: 0.5, voices: 1, gap: 0.05, send: 0, dur: 0.08, variants: 1,
    layers: [{ kind: "tone", f0: 900, f1: 1400, glide: 0.04, peak: 0.14, decay: 0.05 }],
  },
  uiToggleOff: {
    bus: "ui", level: 0.5, voices: 1, gap: 0.05, send: 0, dur: 0.08, variants: 1,
    layers: [{ kind: "tone", f0: 1400, f1: 800, glide: 0.04, peak: 0.12, decay: 0.05 }],
  },
  uiSheetOpen: {
    bus: "ui", level: 0.45, voices: 1, gap: 0.1, send: 0.05, dur: 0.22, variants: 1,
    layers: [{ kind: "hiss", dur: 0.18, seed: 201, f0: 500, f1: 1700, glide: 0.14, q: 0.9, attack: 0.03, peak: 0.12, decay: 0.12 }],
  },
  uiSheetClose: {
    bus: "ui", level: 0.45, voices: 1, gap: 0.1, send: 0.05, dur: 0.22, variants: 1,
    layers: [{ kind: "hiss", dur: 0.18, seed: 202, f0: 1700, f1: 500, glide: 0.14, q: 0.9, attack: 0.02, peak: 0.1, decay: 0.12 }],
  },
  uiReward: {
    bus: "ui", level: 0.55, voices: 1, gap: 0.3, send: 0.4, dur: 1, variants: 1,
    layers: [1174.66, 1479.98, 1760, 2349.32].map((f, i) => ({ kind: "bell" as const, f, t: i * 0.06, peak: 0.12, decay: 0.5, index: 0.6 })),
  },
  uiError: {
    bus: "ui", level: 0.5, voices: 1, gap: 0.2, send: 0.05, dur: 0.32, variants: 1,
    layers: [
      { kind: "tone", wave: "triangle", f0: 330, peak: 0.16, decay: 0.08 },
      { kind: "tone", wave: "triangle", t: 0.11, f0: 262, peak: 0.16, decay: 0.12 },
    ],
  },
} satisfies Record<string, SoundRecipe>;

/** Какие звуки нужны раньше остальных: интерфейс звучит с первого касания. */
export const UI_SOUNDS: readonly SoundId[] = [
  "uiTap",
  "uiBack",
  "uiPress",
  "uiSelect",
  "uiToggleOn",
  "uiToggleOff",
  "uiSheetOpen",
  "uiSheetClose",
  "uiReward",
  "uiError",
];
