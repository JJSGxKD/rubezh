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

export function enemyBody(pattern, rank, stage) {
  let color = PATTERN_COLOR[pattern];
  if (rank !== undefined) color = mix(color, RANK_TINT[rank].color, RANK_TINT[rank].mix);
  const look = STAGES[Math.min(stage, STAGES.length - 1)];
  if (look.mix > 0) color = mix(color, look.mixColor, look.mix);
  return color;
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
