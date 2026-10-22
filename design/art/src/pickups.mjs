// Подборы на земле: кристаллы опыта четырёх ступеней, аптечка, магнит,
// динамит, заморозка и сундуки трёх размеров. Цвета и размеры — из
// `core-game/src/game/render/looks.ts` (GEM_TIERS, PICKUP_LOOKS): ценность
// кристалла читается цветом и размером, вид подбора — силуэтом
// (`docs/27-design-system-and-app-shell.md` §4.4).
//
// Подборы светлее и ярче мира: роль «опыт — светлый яркий» (design/README.md).
// Тень — мягкая синеватая, как у героя: подбор лежит на земле.

const f = (n) => (Math.round(n * 10) / 10).toString();
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100">${inner}</svg>`;
const shadow = (rx, y = 38) => `<ellipse cx="0" cy="${y}" rx="${rx}" ry="${f(rx * 0.3)}" fill="#1d2a3a" opacity="0.45"/>`;

function mix(a, b, t) {
  const ch = (s) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * t));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

/**
 * Кристалл: шестигранник гранями — светлая верхняя грань, тёмная нижняя.
 * `phase` — блик скользит по граням: два кадра мерцания у ценных ступеней.
 */
function gem(color, rich, phase) {
  const light = mix(color, 0xffffff, 0.55);
  const mid = `#${color.toString(16).padStart(6, "0")}`;
  const dark = mix(color, 0x2a1036, 0.45);
  const top = `M0 -40 L28 -14 L0 -4 L-28 -14 Z`;
  const left = `M-28 -14 L0 -4 L0 40 L-24 14 Z`;
  const right = `M28 -14 L24 14 L0 40 L0 -4 Z`;
  const glint = phase === 0 ? `<path d="M-14 -26 L-6 -30 L-10 -20 Z" fill="#fff" opacity="0.9"/>` : `<path d="M6 -24 L14 -20 L8 -14 Z" fill="#fff" opacity="0.9"/>`;
  const star = rich
    ? `<path d="M0 -6 L4 4 L14 6 L4 9 L0 20 L-4 9 L-14 6 L-4 4 Z" fill="#fff8e0"/>`
    : "";
  return svg(`${shadow(20, 44)}<path d="${top}" fill="${light}"/><path d="${left}" fill="${mid}"/><path d="${right}" fill="${dark}"/>${glint}${star}`);
}

function medkit() {
  return svg(`${shadow(30)}<rect x="-32" y="-22" width="64" height="52" rx="10" fill="#f3f6fc"/><rect x="-32" y="14" width="64" height="16" rx="8" fill="#c9d0e6"/>
<path d="M-14 -24 v-8 a6 6 0 0 1 6 -6 h16 a6 6 0 0 1 6 6 v8" fill="none" stroke="#c9d0e6" stroke-width="6"/>
<path d="M-6 -12 h12 v10 h10 v12 h-10 v10 h-12 v-10 h-10 v-12 h10 Z" fill="#ff5d5d"/>`);
}

function magnet() {
  return svg(`${shadow(28)}<path d="M-28 20 V-6 A28 28 0 0 1 28 -6 V20 H12 V-6 A12 12 0 0 0 -12 -6 V20 Z" fill="#5ccfff"/>
<path d="M-28 -6 A28 28 0 0 1 0 -34 V-18 A12 12 0 0 0 -12 -6 Z" fill="#a8e6ff"/>
<rect x="-28" y="14" width="16" height="16" fill="#f3f6fc"/><rect x="12" y="14" width="16" height="16" fill="#f3f6fc"/>
<path d="M-38 -30 l6 4 M38 -30 l-6 4 M0 -46 v7" stroke="#a8e6ff" stroke-width="4" stroke-linecap="round"/>`);
}

function dynamite(phase) {
  const spark = phase === 0 ? 1 : 0.7;
  return svg(`${shadow(30)}<g transform="rotate(-12)">
${[-18, 0, 18].map((x) => `<rect x="${x - 9}" y="-24" width="18" height="54" rx="6" fill="#ff5d5d"/><rect x="${x - 9}" y="-24" width="6" height="54" rx="3" fill="#ff8a8a"/>`).join("")}
<rect x="-29" y="-2" width="58" height="9" fill="#3a1414"/><rect x="-29" y="14" width="58" height="6" fill="#3a1414"/>
<path d="M0 -24 Q4 -36 14 -38" fill="none" stroke="#f3f6fc" stroke-width="3"/>
<circle cx="15" cy="-39" r="${f(9 * spark)}" fill="#ffe066" opacity="0.45"/><circle cx="15" cy="-39" r="${f(4 * spark)}" fill="#fff6c8"/>
</g>`);
}

/**
 * Заморозка (T-0116, design/art/direction-v2.md §5.1): ледяная звезда —
 * шесть игл вокруг инеистой сферы со снежинкой. Силуэт не ромб, как у
 * кристаллов опыта, и не дуга магнита того же голубого: звезда с шипами
 * читается «лёд, а не опыт». `phase` — блик обходит иглы, два кадра.
 */
function freeze(phase) {
  const spikes = [0, 1, 2, 3, 4, 5]
    .map((i) => {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const tip = [Math.cos(a) * 44, Math.sin(a) * 44 - 4];
      const l = [Math.cos(a - 0.32) * 18, Math.sin(a - 0.32) * 18 - 4];
      const r = [Math.cos(a + 0.32) * 18, Math.sin(a + 0.32) * 18 - 4];
      const lit = i === (phase === 0 ? 5 : 1);
      return `<path d="M${f(l[0])} ${f(l[1])} L${f(tip[0])} ${f(tip[1])} L${f(r[0])} ${f(r[1])} Z" fill="${lit ? "#ffffff" : "#b8ecff"}" stroke="#4f9dff" stroke-width="2.5" stroke-linejoin="round"/>`;
    })
    .join("");
  const flake = [0, 1, 2]
    .map((i) => {
      const a = (i / 3) * Math.PI;
      return `M${f(Math.cos(a) * -11)} ${f(Math.sin(a) * -11 - 4)} L${f(Math.cos(a) * 11)} ${f(Math.sin(a) * 11 - 4)}`;
    })
    .join(" ");
  return svg(`${shadow(24)}${spikes}<circle cx="0" cy="-4" r="19" fill="#e6f7ff" stroke="#4f9dff" stroke-width="3"/>
<circle cx="-6" cy="-11" r="6" fill="#ffffff" opacity="0.8"/><path d="${flake}" stroke="#4f9dff" stroke-width="3.5" stroke-linecap="round"/>`);
}

/** Сундук: корпус, крышка, золотые полосы и замок. `open` — крышка откинута, изнутри свет. */
function chest(gold, open) {
  const wood = "#7a4a33";
  const woodLight = "#9a603f";
  const band = gold;
  const lid = open
    ? `<path d="M-34 -10 L-30 -40 L30 -40 L34 -10 Z" fill="${woodLight}"/><rect x="-6" y="-40" width="12" height="30" fill="${band}"/>
<path d="M-28 -6 L28 -6 L20 -50 L-20 -50 Z" fill="#ffe6a0" opacity="0.5"/>`
    : `<path d="M-36 -6 Q-36 -32 0 -32 Q36 -32 36 -6 Z" fill="${woodLight}"/><rect x="-6" y="-32" width="12" height="26" fill="${band}"/>`;
  return svg(`${shadow(36, 36)}${lid}
<rect x="-36" y="-8" width="72" height="42" rx="4" fill="${wood}"/>
<rect x="-36" y="-8" width="72" height="8" fill="${band}"/><rect x="-36" y="26" width="72" height="6" fill="${band}" opacity="0.8"/>
<rect x="-30" y="-8" width="8" height="42" fill="${band}" opacity="0.85"/><rect x="22" y="-8" width="8" height="42" fill="${band}" opacity="0.85"/>
${open ? "" : `<rect x="-8" y="-2" width="16" height="18" rx="3" fill="#fff1c0"/><circle cx="0" cy="6" r="3" fill="${wood}"/>`}`);
}

/** Кадры подборов: размер ячейки — в игровых единицах. */
export const PICKUPS = [
  { id: "gem1", units: 13, frames: [gem(0xb6ff4a, false, 0)] },
  { id: "gem2", units: 16, frames: [gem(0xa8f4ff, false, 0)] },
  { id: "gem3", units: 20, frames: [gem(0xd68cff, false, 0), gem(0xd68cff, false, 1)] },
  { id: "gem4", units: 26, frames: [gem(0xffd15c, true, 0), gem(0xffd15c, true, 1)] },
  { id: "medkit", units: 22, frames: [medkit()] },
  { id: "magnet", units: 24, frames: [magnet()] },
  { id: "dynamite", units: 26, frames: [dynamite(0), dynamite(1)] },
  // Заготовка под T-0116: подбора ещё нет в движке, кадры ждут в атласе.
  { id: "freeze", units: 26, frames: [freeze(0), freeze(1)] },
  { id: "chest1", units: 28, frames: [chest("#d9a441", false), chest("#d9a441", true)] },
  { id: "chest3", units: 32, frames: [chest("#f0bb3a", false), chest("#f0bb3a", true)] },
  { id: "chest5", units: 36, frames: [chest("#ffd44d", false), chest("#ffd44d", true)] },
];
