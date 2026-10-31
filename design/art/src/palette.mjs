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

/** Ступени — те же, что STAGE_LOOKS: вторая светлеет к золоту, третья темнеет к вишне. */
export const STAGES = [
  { mixColor: 0x000000, mix: 0, eye: 0xffe8a3 },
  { mixColor: 0xffd15c, mix: 0.25, eye: 0xfff7e0 },
  { mixColor: 0x3b0a1f, mix: 0.35, eye: 0xffd9e0 },
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
];

/** Свечение Нави под врагом: общий знак враждебности, у героя и декора его нет. */
export const NAV_GLOW = 0x5a1238;

export function enemyBody(pattern, rank, stage, id, version = 2) {
  if (version === 2 && id !== undefined && SPECIES_COLOR[id] !== undefined) {
    let color = SPECIES_COLOR[id];
    const look = STAGES_V2[Math.min(stage, STAGES_V2.length - 1)];
    if (look.mix > 0) color = mix(color, look.mixColor, look.mix);
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
  scarf: "#ff8f3f",
  scarfShade: "#c9652a",
  ward: "#46d9c6",
  wardLight: "#b9fff4",
  staff: "#7a5a43",
  boots: "#3a3550",
};
