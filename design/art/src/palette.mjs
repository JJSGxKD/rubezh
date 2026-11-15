// Палитра арта забега. Источник — `packages/core-game/src/game/render/looks.ts`:
// цвет тела врага — по паттерну, ранг и ступень — смешением. Здесь те же числа,
// чтобы спрайт стоял на месте фигуры без спора о цвете (design/README.md, «Вид боя»).

export const PATTERN_COLOR = {
  swarm: 0xff4d5a,
  chase: 0xe0245e,
  kite_and_shoot: 0xff6a6a,
  dash: 0xff5a2e,
  orbit: 0xff7a90,
  exploder: 0xff3b30,
  splitter: 0xd93a6a,
  rush: 0xff9a8a,
  caster: 0xc2185b,
};

const RANK_TINT = {
  elite: { color: 0xff8f3f, mix: 0.35 },
  boss: { color: 0xff4f8f, mix: 0.4 },
};

/**
 * Ступени — те же, что STAGE_LOOKS: вторая светлеет к золоту, третья темнеет к
 * вишне, дальше каждая темнее и холоднее, а глаза светлее (ядро фигуры).
 */
export const STAGES = [
  { mixColor: 0x000000, mix: 0, eye: 0xffe8a3 },
  { mixColor: 0xffd15c, mix: 0.25, eye: 0xfff7e0 },
  { mixColor: 0x3b0a1f, mix: 0.35, eye: 0xffd9e0 },
  { mixColor: 0x240a3a, mix: 0.45, eye: 0xe9d4ff },
  { mixColor: 0x0a0a1a, mix: 0.55, eye: 0xd4e8ff },
  { mixColor: 0x000000, mix: 0.65, eye: 0xffffff },
];

export const GOLD_RIM = 0xffd15c;

export function mix(from, to, ratio) {
  const ch = (shift) => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * ratio);
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

export function hex(color) {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/**
 * Палитра существа из одного цвета тела: тень, свет и тёмная деталь — сдвигом
 * к фиолетовым сумеркам и к тёплому свету, а не к чёрному и белому: так
 * красные твари остаются частью сумеречного мира, а не наклейками на нём.
 */
export function creaturePalette(body, eye = 0xffe8a3) {
  return {
    body: hex(body),
    shade: hex(mix(body, 0x2a1036, 0.38)),
    deep: hex(mix(body, 0x1d0b22, 0.68)),
    light: hex(mix(body, 0xfff1d6, 0.42)),
    eye: hex(eye),
    pupil: "#2a0d1c",
    bone: hex(mix(0xf3e6cf, body, 0.18)),
  };
}

/**
 * Палитра v2 (design/art/direction-v2.md §4.2). «Цвет по угрозе» был нужен
 * фигурам: красный круг отличал врага от всего остального. Спрайт читается
 * силуэтом, поэтому у каждого существа — свой цвет, а враждебность говорят
 * общие для всех врагов знаки: горящие глаза и свечение Нави под ногами.
 *
 * Запретные для тел цвета: салатовый — кристаллы опыта, чистое золото — кайма
 * элиты и монеты, бирюза — обереги героя. Тела темнее или светлее земли
 * (#33506a и её зоны) хотя бы на ступень — силуэт не тонет.
 */
export const SPECIES_COLOR = {
  swarm_rat: 0x9a7764, // пыльно-бурая крыса
  mire_shambler: 0x9aa85c, // болотный, тиной — светлее топи, иначе тонет в ней
  tank_ghoul: 0x8ea284, // трупная зелень
  bone_walker: 0xd9ccb0, // кость
  shooter_wisp: 0x8fd3ff, // блуждающий огонёк (уходит, T-0172)
  dasher_wolf: 0x8a8079, // серо-бурый волк
  circler_crow: 0x2c2440, // чёрный ворон — темнее земли
  bomber_imp: 0xe45a2a, // огненный бес
  splitter_slime: 0x9a62c4, // болотный слизень
  rushing_bats: 0x7a4c6c, // нетопыри — светлее ворона: мелкие, а читаться обязаны
  elite_ghoul: 0x8ea284,
  elite_grave_knight: 0x8d97ab, // латы
  boss_seer: 0x6c4fa8, // вещун (уходит, T-0172)
  boss_matryoshka: 0xd8322f, // красная — её образ
  rubezh_guard: 0x9a7350, // Чур — старое дерево
  cordon_guard: 0x7f8796, // латы щитоносца
  boss_ram: 0x6b5446, // тёмная шерсть Тарана
  ice_spirit: 0xa9dcf5, // лёд — светлее земли, холоднее огонька
  bog_lurker: 0x6f8a46, // топь — темнее увальня
  kikimora: 0x6a9a86, // болотная зелень с сизым
  leshy: 0x6b5a3a, // кора
  boss_gorynych: 0x4f7f4a, // змеиная зелень; головы — тоном стихии фазы
};

/**
 * Ступени v2 — тоном тела и цветом глаз: закалённый выцветает к кости и
 * смотрит золотом, древний темнеет к Нави и смотрит фиолетовым.
 */
export const STAGES_V2 = [
  { mixColor: 0x000000, mix: 0, eye: 0xff7a3d },
  { mixColor: 0xe8d6a8, mix: 0.24, eye: 0xffd23f },
  { mixColor: 0x34124a, mix: 0.32, eye: 0xff5adc },
  // Поздние ступени (Р215, T-0441) продолжают линию «к Нави»: тело всё глубже в
  // холодный фиолет и темнее по светлоте OKLab (`maxL` — потолок: светлая тварь
  // — кость, дух — иначе не пересекла бы светлоту земли на одну ступень и
  // тонула в ней), глаза — тот же розовый, но светлее: к 14-й минуте белые.
  // Не салатовый, не золото, не бирюза: эти цвета заняты (§2.1).
  { mixColor: 0x1c1032, mix: 0.5, maxL: 0.26, eye: 0xff8fe6 },
  { mixColor: 0x140a28, mix: 0.66, maxL: 0.19, eye: 0xffbdf0 },
  { mixColor: 0x0a0618, mix: 0.8, maxL: 0.12, eye: 0xfff0fb },
];

const linear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const gamma = (v) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/** Цвет в OKLab: светлота `L` (0…1) и ось цветности `a`, `b`. */
export function toOklab(color) {
  const r = linear((color >> 16) & 0xff);
  const g = linear((color >> 8) & 0xff);
  const b = linear(color & 0xff);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/**
 * Не светлее `maxL` по OKLab: светлота и цветность сжимаются вместе, оттенок
 * остаётся. Светлее потолка тело становится ровно на потолке, темнее — не
 * меняется.
 */
export function capLightness(color, maxL) {
  const lab = toOklab(color);
  if (lab.L <= maxL) return color;
  const k = maxL / lab.L;
  const a = lab.a * k;
  const bb = lab.b * k;
  const l3 = (maxL + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m3 = (maxL - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s3 = (maxL - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  const lr = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const lg = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const lb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  return (gamma(lr) << 16) | (gamma(lg) << 8) | gamma(lb);
}

/** Свечение Нави под врагом: общий знак враждебности, у героя и декора его нет. */
export const NAV_GLOW = 0x5a1238;

export function enemyBody(pattern, rank, stage, id, version = 2) {
  if (version === 2 && id !== undefined && SPECIES_COLOR[id] !== undefined) {
    let color = SPECIES_COLOR[id];
    const look = STAGES_V2[Math.min(stage, STAGES_V2.length - 1)];
    if (look.mix > 0) color = mix(color, look.mixColor, look.mix);
    if (look.maxL !== undefined) color = capLightness(color, look.maxL);
    return color;
  }
  let color = PATTERN_COLOR[pattern];
  if (rank !== undefined) color = mix(color, RANK_TINT[rank].color, RANK_TINT[rank].mix);
  const look = STAGES[Math.min(stage, STAGES.length - 1)];
  if (look.mix > 0) color = mix(color, look.mixColor, look.mix);
  return color;
}

/** Цвет глаз по ступени и версии палитры. */
export function enemyEye(stage, version = 2) {
  const stages = version === 2 ? STAGES_V2 : STAGES;
  return stages[Math.min(stage, stages.length - 1)].eye;
}

/** Герой: светлый плащ, бирюза оберега, тёплое лицо и кант сумерек. */
export const HERO = {
  cloak: "#f4f7ff",
  cloakShade: "#c3c9e2",
  cloakDeep: "#8d93b8",
  edge: "#1d1c31",
  skin: "#f2c39b",
  skinShade: "#d39a76",
  // Волосы — затылок под шапкой у вида спиной; венку ведуньи облик даёт свои.
  hair: "#6b4a34",
  scarf: "#ff8f3f",
  scarfShade: "#c9652a",
  ward: "#46d9c6",
  wardLight: "#b9fff4",
  staff: "#7a5a43",
  boots: "#3a3550",
};
