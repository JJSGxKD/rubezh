// Окружение бесконечной карты «Рубеж»: бесшовные плитки земли трёх зон и
// декор. Земля — средний сумеречный тон (design/README.md, «Вид боя»): на нём
// сильнее всего читается красный враг, поэтому декор не красный, не белый, не
// бирюзовый и не ярко-жёлтый — эти цвета заняты ролями (враг, герой, своё
// оружие, опыт). Декор темнее или светлее земли на полтона, не больше.

const TAU = Math.PI * 2;
const f = (n) => (Math.round(n * 10) / 10).toString();

/** Детерминированный генератор для раскладки рисунка плитки — чтобы сборка повторялась. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Зоны: луг — основная, погост и топь — разнообразие. Тона соседствуют по
 * светлоте, поэтому переход между зонами — смена оттенка, а не ступенька яркости.
 */
export const ZONES = {
  meadow: { base: "#33506a", spot: "#2c475e", light: "#3d5c74", fleck: "#4a6d7c" },
  graveyard: { base: "#434660", spot: "#393c55", light: "#4f526c", fleck: "#5f617a" },
  mire: { base: "#2b5656", spot: "#244a4b", light: "#356464", fleck: "#467466" },
  // Нейтральная плитка под окраску по вершинам: цвет зоны умножается на неё в
  // рендере, поэтому основа светлая, пятна — на полтона темнее и светлее.
  neutral: { base: "#dcdcdc", spot: "#c6c6c6", light: "#f2f2f2", fleck: "#fafafa" },
};

/** Доля основы нейтральной плитки: тинт зоны = желаемый цвет / NEUTRAL_BASE. */
export const NEUTRAL_BASE = 0xdc / 0xff;

/**
 * Бесшовная плитка: каждое пятно рисуется девять раз со сдвигом на размер
 * плитки, и то, что вышло за край, входит с другой стороны. Пятна на плитке
 * тихие: крупный рисунок повторяется каждые 256 единиц и на обзоре
 * складывается в решётку. Крупную неровность даёт не плитка, а пятна чанков
 * поверх неё (prototype/arena.html, `buildChunk`).
 */
export function groundTile(zone, size = 512, seed = 7) {
  const z = ZONES[zone];
  const r = rng(seed);
  let blobs = "";
  let flecks = "";
  const wrap = (shape) => {
    let out = "";
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) out += `<g transform="translate(${dx} ${dy})">${shape}</g>`;
    return out;
  };
  const k = size / 256;
  for (let i = 0; i < 16; i++) {
    const x = r() * size, y = r() * size, rx = (20 + r() * 44) * k, ry = rx * (0.5 + r() * 0.4);
    blobs += wrap(`<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(rx)}" ry="${f(ry)}" fill="${i % 3 === 0 ? z.light : z.spot}" opacity="0.45" transform="rotate(${f(r() * 180)} ${f(x)} ${f(y)})"/>`);
  }
  // Травинки кучками по три-пять: одиночные штрихи на плитке складываются в
  // ровную сетку точек и выдают повтор, кучки — нет.
  for (let i = 0; i < 26; i++) {
    const cx = r() * size, cy = r() * size, n = 3 + Math.floor(r() * 3);
    for (let j = 0; j < n; j++) {
      const x = cx + (r() - 0.5) * 22 * k, y = cy + (r() - 0.5) * 12 * k, h = (8 + r() * 8) * k;
      flecks += wrap(`<path d="M${f(x)} ${f(y)} q${f((r() - 0.5) * 6 * k)} ${f(-h * 0.6)} ${f((r() - 0.5) * 8 * k)} ${f(-h)}" fill="none" stroke="${z.fleck}" stroke-width="${f(2.4 * k)}" stroke-linecap="round" opacity="0.75"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><filter id="soft"><feGaussianBlur stdDeviation="${f(8 * (size / 256))}"/></filter><rect width="${size}" height="${size}" fill="${z.base}"/><g filter="url(#soft)">${blobs}</g>${flecks}</svg>`;
}

const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100">${inner}</svg>`;

/** Мягкая тень декора: плоская, синеватая — земля средней светлоты не терпит чёрных пятен. */
const shade = (rx, ry = rx * 0.32, y = 40) => `<ellipse cx="0" cy="${y}" rx="${rx}" ry="${f(ry)}" fill="#1d2a3a" opacity="0.45"/>`;

/** Декор: `units` — размер ячейки в игровых единицах, `zones` — где встречается. */
export const DECOR = [
  {
    id: "grass", units: 16, zones: ["meadow", "mire"], variants: 3,
    draw: (v) => svg(`${[-14, -4, 6, 14].map((x, i) => `<path d="M${x} 40 Q${x + (i % 2 ? 6 : -6) + v * 2} 10 ${x + (i % 2 ? 10 : -8) + v * 3} ${-10 - ((i + v) % 3) * 8}" fill="none" stroke="${i % 2 ? "#4f7a72" : "#44695f"}" stroke-width="5" stroke-linecap="round"/>`).join("")}`),
  },
  {
    id: "stone", units: 18, zones: ["meadow", "graveyard"], variants: 3,
    draw: (v) => svg(`${shade(34)}<path d="M-34 36 Q-36 ${10 - v * 6} -14 ${-6 - v * 4} Q8 -16 28 ${-2 + v * 3} Q38 14 32 36 Z" fill="#5d6b82"/><path d="M-26 20 Q-20 ${2 - v * 4} -6 ${-4 - v * 3}" fill="none" stroke="#7a88a0" stroke-width="5" stroke-linecap="round"/><path d="M4 36 Q20 26 32 34" fill="none" stroke="#4b566c" stroke-width="5"/>`),
  },
  {
    id: "cross", units: 26, zones: ["graveyard"], variants: 2,
    draw: (v) => svg(`${shade(22, 7)}<g transform="rotate(${v ? -9 : 6} 0 40)"><rect x="-5" y="-40" width="10" height="80" rx="2" fill="#6b5a5e"/><rect x="-22" y="-24" width="44" height="9" rx="2" fill="#6b5a5e"/><rect x="-3" y="-38" width="4" height="70" fill="#7f6c70"/>${v ? `<path d="M-22 -20 Q0 -10 22 -20" fill="none" stroke="#8a7f9b" stroke-width="2.5"/>` : ""}</g>`),
  },
  {
    id: "grave", units: 30, zones: ["graveyard"], variants: 2,
    draw: (v) => svg(`${shade(36, 9)}<path d="M-30 40 Q-32 10 -10 -2 L10 -2 Q32 10 30 40 Z" fill="#46505f"/><path d="M-26 40 Q-26 18 -8 8" fill="none" stroke="#56616f" stroke-width="5"/>${v ? `<path d="M-16 -2 L-16 -34 Q0 -46 16 -34 L16 -2 Z" fill="#646d80"/><path d="M-6 -24 h12 M0 -30 v14" stroke="#4b5366" stroke-width="3"/>` : `<rect x="-14" y="-28" width="28" height="30" rx="12" fill="#646d80"/>`}`),
  },
  {
    id: "reeds", units: 22, zones: ["mire"], variants: 2,
    draw: (v) => svg(`${[-16, -6, 4, 14].map((x, i) => `<path d="M${x} 40 L${x + (i - 1.5) * (3 + v)} ${-30 + (i % 2) * 14}" stroke="#4c6f5c" stroke-width="4" stroke-linecap="round"/><ellipse cx="${x + (i - 1.5) * (3 + v)}" cy="${-30 + (i % 2) * 14}" rx="3.5" ry="9" fill="#6b5446"/>`).join("")}`),
  },
  {
    id: "puddle", units: 34, zones: ["mire"], variants: 2,
    draw: (v) => svg(`<ellipse cx="0" cy="${v ? 14 : 8}" rx="44" ry="${v ? 18 : 24}" fill="#26404c"/><ellipse cx="-8" cy="${v ? 10 : 2}" rx="26" ry="${v ? 7 : 10}" fill="#2f5664" opacity="0.8"/><path d="M-20 ${v ? 6 : -4} q10 -4 20 0" fill="none" stroke="#5e8a92" stroke-width="2.5" opacity="0.7"/>`),
  },
  {
    id: "mushrooms", units: 14, zones: ["meadow", "mire"], variants: 2,
    draw: (v) => svg(`${shade(28)}${[[-14, 6, 1], [8, 14, 0.8], [v ? 22 : -26, 24, 0.6]].map(([x, y, s]) => `<rect x="${x - 3 * s}" y="${y}" width="${6 * s}" height="${26 - y + 14}" rx="2" fill="#c8bba4"/><path d="M${x - 16 * s} ${y + 2} Q${x} ${y - 20 * s} ${x + 16 * s} ${y + 2} Z" fill="#8f6aa8"/><circle cx="${x - 4 * s}" cy="${y - 5 * s}" r="${2.5 * s}" fill="#b89ccb"/>`).join("")}`),
  },
  {
    id: "stump", units: 24, zones: ["meadow"], variants: 1,
    draw: () => svg(`${shade(34, 10)}<path d="M-26 38 L-22 -6 L22 -6 L26 38 Q0 44 -26 38 Z" fill="#5a4a4a"/><ellipse cx="0" cy="-6" rx="22" ry="9" fill="#8a7464"/><ellipse cx="0" cy="-6" rx="12" ry="5" fill="none" stroke="#6e5a4e" stroke-width="2.5"/><path d="M-26 38 L-38 42 M26 38 L36 44" stroke="#5a4a4a" stroke-width="6" stroke-linecap="round"/>`),
  },
  {
    id: "bones", units: 16, zones: ["graveyard", "mire"], variants: 2,
    draw: (v) => svg(`<g transform="rotate(${v ? 30 : -20})"><rect x="-30" y="-4" width="60" height="8" rx="4" fill="#9a93a3"/><circle cx="-30" cy="-5" r="6" fill="#9a93a3"/><circle cx="-30" cy="5" r="6" fill="#9a93a3"/><circle cx="30" cy="-5" r="6" fill="#9a93a3"/><circle cx="30" cy="5" r="6" fill="#9a93a3"/></g>${v ? `<circle cx="18" cy="22" r="11" fill="#8c8596"/><circle cx="14" cy="21" r="2.6" fill="#3a3550"/><circle cx="22" cy="21" r="2.6" fill="#3a3550"/>` : ""}`),
  },
  // Ориентир: обережный столб — редкий, крупный, видно издалека. Помогает
  // понять, что игрок двигается и где он уже был, но в бою не мешает: ниже
  // героя по яркости и без бирюзы оберегов в полную силу.
  {
    id: "landmark_pillar", units: 70, zones: ["meadow", "graveyard", "mire"], variants: 1, landmark: true,
    draw: () => svg(`${shade(30, 9, 42)}<path d="M-14 42 L-11 -36 Q0 -46 11 -36 L14 42 Z" fill="#5b6280"/><path d="M-9 40 L-7 -34" stroke="#6c7393" stroke-width="5"/>${[-20, -2, 16].map((y) => `<path d="M-10 ${y} L0 ${y - 7} L10 ${y} L0 ${y + 7} Z" fill="none" stroke="#7fb7b4" stroke-width="2.5" opacity="0.75"/>`).join("")}<circle cx="0" cy="-36" r="5" fill="#9fd3cc" opacity="0.6"/>`),
  },
  {
    id: "landmark_well", units: 60, zones: ["meadow", "graveyard"], variants: 1, landmark: true,
    draw: () => svg(`${shade(40, 12, 40)}<ellipse cx="0" cy="22" rx="34" ry="16" fill="#4e5670"/><ellipse cx="0" cy="16" rx="30" ry="12" fill="#1f2b3a"/><path d="M-34 22 v12 q34 16 68 0 v-12" fill="#5e6784"/><path d="M-26 14 L-24 -34 M26 14 L24 -34 M-32 -32 L0 -46 L32 -32" fill="none" stroke="#6b5a5e" stroke-width="5" stroke-linecap="round"/><path d="M0 -40 v34" stroke="#8a8197" stroke-width="2"/>`),
  },
];

export function decorFrames(ppu = 3) {
  const frames = [];
  for (const item of DECOR) {
    for (let v = 0; v < item.variants; v++) {
      frames.push({ name: `decor/${item.id}${v}`, svg: item.draw(v), size: Math.ceil(item.units * ppu) });
    }
  }
  return frames;
}
