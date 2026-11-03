// Тайники рубежа (design/art/meta-v2.md §5): места на бесконечной карте,
// которые игрок находит сам. Облик до механики — как у запланированных
// существ: задача придёт, а рисунок уже готов.
//
// Тайник не должен спорить с врагом и опытом за внимание в бою: он темнее
// героя, без красного и без ярко-жёлтого опыта. Найденный тайник «оживает»
// бирюзой оберегов или фиолетом Нави — так он отличается от декора, мимо
// которого игрок бежит не глядя.

const f = (n) => (Math.round(n * 10) / 10).toString();
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100">${inner}</svg>`;
const shade = (rx, ry = rx * 0.32, y = 40) => `<ellipse cx="0" cy="${y}" rx="${rx}" ry="${f(ry)}" fill="#1d2a3a" opacity="0.45"/>`;
const glow = (r, color, y = 0, opacity = 0.35) => `<circle cx="0" cy="${y}" r="${r}" fill="${color}" opacity="${opacity}"/>`;
/** Свечение по земле — плоское: тайник светится местом, а не висит шаром. */
const groundGlow = (rx, color, y, opacity) => `<ellipse cx="0" cy="${y}" rx="${rx}" ry="${f(rx * 0.36)}" fill="${color}" opacity="${opacity}"/>`;
/** Столб света над действующим местом: видно издалека, сквозь толпу. */
const pillar = (color, top = -48, bottom = 18, w = 16) =>
  `<defs><linearGradient id="pillar" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${color}" stop-opacity="0.45"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="M${-w} ${bottom} L${-w * 0.6} ${top} L${w * 0.6} ${top} L${w} ${bottom} Z" fill="url(#pillar)"/>`;

const WARD = "#46d9c6";
const WARD_LIGHT = "#b9fff4";
const NAV = "#a06cff";
const NAV_LIGHT = "#e2d1ff";
const GOLD = "#ffd15c";

/**
 * Тайники. `units` — размер в игровых единицах; `states` — облики по
 * состояниям: `hint` — огонёк, который выдаёт место издалека, `found` —
 * найден, `active` — действует (игрок внутри или награда выдана).
 */
export const SECRETS = [
  {
    id: "shrine",
    name: "Капище",
    what: "постоять в круге 3 с — выбрать благословение на забег",
    units: 64,
    states: {
      found: () => shrine(false),
      active: () => shrine(true),
    },
  },
  {
    id: "hoard",
    name: "Клад",
    what: "постоять на месте 2 с — выкопать сундук",
    units: 40,
    states: {
      found: () => hoard(false),
      active: () => hoard(true),
    },
  },
  {
    id: "tree",
    name: "Древо-оберег",
    what: "рядом лечит и даёт щит раз в минуту",
    units: 70,
    states: {
      found: () => tree(false),
      active: () => tree(true),
    },
  },
  {
    id: "rift",
    name: "Разлом Нави",
    what: "войти — волна элит; выдержал — большой сундук",
    units: 60,
    states: {
      found: () => rift(false),
      active: () => rift(true),
    },
  },
  {
    // id — как вид тайника в движке (`SecretKind`): по нему движок ищет кадр.
    id: "stone",
    name: "Камень-указатель",
    what: "коснуться — тайники вокруг видны на радаре",
    units: 50,
    states: {
      found: () => waystone(false),
      active: () => waystone(true),
    },
  },
  {
    id: "wisp",
    name: "Блуждающий огонёк",
    what: "выдаёт тайник рядом: летит к нему",
    units: 18,
    states: {
      hint: () => wisp(0),
      active: () => wisp(1),
    },
  },
];

/** Капище: круг стоячих камней и резной столб с ликом; действует — руны горят. */
function shrine(active) {
  const stones = [-150, -110, -70, -30, 10, 50, 90, 130, 170, 210].map((deg, i) => {
    const a = (deg * Math.PI) / 180;
    const x = Math.cos(a) * 38;
    const y = 18 + Math.sin(a) * 15;
    const h = 12 + (i % 3) * 3;
    const lit = active && i % 2 === 0;
    return { y, svg: `<path d="M${f(x - 4)} ${f(y + 2)} L${f(x - 3)} ${f(y - h)} Q${f(x)} ${f(y - h - 4)} ${f(x + 3)} ${f(y - h)} L${f(x + 4)} ${f(y + 2)} Z" fill="#5d6680"/>${lit ? `<path d="M${f(x)} ${f(y - h + 3)} v5" stroke="${WARD_LIGHT}" stroke-width="1.6" stroke-linecap="round"/>` : ""}` };
  });
  const back = stones.filter((s) => s.y < 18).map((s) => s.svg).join("");
  const front = stones.filter((s) => s.y >= 18).map((s) => s.svg).join("");
  const ring = `<ellipse cx="0" cy="18" rx="34" ry="12" fill="${active ? WARD : "#2a3a4a"}" opacity="${active ? 0.28 : 0.5}"/>`;
  const idol = `<path d="M-7 22 L-6 -30 Q0 -38 6 -30 L7 22 Z" fill="#7a5a46"/><path d="M-6 -28 Q0 -34 6 -28 L6 -22 L-6 -22 Z" fill="#8f6c54"/>
<circle cx="-2.5" cy="-18" r="1.6" fill="${active ? WARD_LIGHT : "#3a2c26"}"/><circle cx="2.5" cy="-18" r="1.6" fill="${active ? WARD_LIGHT : "#3a2c26"}"/>
<path d="M-3 -12 h6" stroke="#3a2c26" stroke-width="1.6"/><path d="M-6 -4 h12 M-6 6 h12" stroke="#5f4636" stroke-width="2"/>`;
  return svg(`${shade(44, 14, 26)}${active ? groundGlow(40, WARD, 18, 0.25) + pillar(WARD, -50, 18, 20) : ""}${ring}${back}${idol}${front}`);
}

/** Клад: холмик с колышками крест-накрест и блеском; выкопан — сундучок в яме. */
function hoard(open) {
  if (!open) {
    return svg(`${shade(30, 9, 30)}<path d="M-30 30 Q-24 4 0 0 Q24 4 30 30 Z" fill="#5a4a44"/><path d="M-20 24 Q-12 10 0 8" fill="none" stroke="#6e5c54" stroke-width="4" stroke-linecap="round"/>
<path d="M-8 -14 L8 6 M8 -14 L-8 6" stroke="#7a5a3e" stroke-width="4" stroke-linecap="round"/>
<path d="M14 -2 l2 4 4 2 -4 2 -2 4 -2 -4 -4 -2 4 -2 Z" fill="${GOLD}" opacity="0.85"/>`);
  }
  return svg(`${shade(32, 10, 30)}<ellipse cx="0" cy="22" rx="30" ry="11" fill="#2a2228"/><path d="M-30 22 Q-34 30 -24 32 M30 22 Q34 30 24 32" stroke="#5a4a44" stroke-width="6" fill="none" stroke-linecap="round"/>
<rect x="-14" y="2" width="28" height="18" rx="3" fill="#8a5a34"/><rect x="-14" y="2" width="28" height="5" fill="#a87244"/><path d="M-14 -8 Q0 -16 14 -8 L14 2 L-14 2 Z" fill="#9a6a3e" transform="rotate(-18 -14 2)"/>
<rect x="-2.5" y="6" width="5" height="7" rx="1" fill="${GOLD}"/>${glow(16, GOLD, 0, 0.25)}
<path d="M-6 -6 l2 -6 M4 -8 l1 -6 M12 -2 l4 -4" stroke="${GOLD}" stroke-width="2" stroke-linecap="round"/>`);
}

/** Древо-оберег: берёзка с лентами; действует — бирюзовое кольцо под корнями. */
function tree(active) {
  const ribbons = [[-10, -6, "#e8e0d6"], [6, -14, "#c84a3a"], [12, 2, "#e8e0d6"], [-4, -22, "#c84a3a"]]
    .map(([x, y, c]) => `<path d="M${x} ${y} q3 6 -1 12 q4 -4 6 0" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>`)
    .join("");
  const leaves = [[-14, -26, 13], [8, -32, 15], [-2, -40, 12], [18, -18, 10], [-20, -12, 9]]
    .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${active ? "#5e9a78" : "#4d7a62"}"/>`)
    .join("");
  return svg(`${shade(34, 11, 40)}${active ? `<ellipse cx="0" cy="38" rx="34" ry="10" fill="none" stroke="${WARD}" stroke-width="3" opacity="0.8"/>${groundGlow(34, WARD, 38, 0.22)}` : ""}
<path d="M-3 40 L-2 -10 Q0 -14 2 -10 L4 40 Z" fill="#e6e1d8"/><path d="M-2 6 h4 M-2 18 h4 M-1 28 h3" stroke="#3a3550" stroke-width="1.6"/>
<path d="M0 -4 L-12 -14 M1 -8 L12 -18" stroke="#d6d0c4" stroke-width="2.4" stroke-linecap="round"/>${leaves}${ribbons}`);
}

/** Разлом Нави: трещина в земле с туманом и искрами; действует — разлом шире и ярче. */
function rift(active) {
  const w = active ? 1.35 : 1;
  const crack = `<path d="M-34 14 L-18 ${f(10 - 4 * w)} L-8 ${f(16 + 2 * w)} L4 ${f(8 - 5 * w)} L16 ${f(16 + 3 * w)} L34 10 L20 ${f(18 + 6 * w)} L6 ${f(14 + 8 * w)} L-6 ${f(22 + 5 * w)} L-20 ${f(16 + 6 * w)} Z" fill="#1a0f2e"/>`;
  const glowCrack = `<path d="M-30 14 L-18 ${f(12 - 2 * w)} L-8 ${f(17 + w)} L4 ${f(11 - 3 * w)} L16 ${f(17 + 2 * w)} L30 12" fill="none" stroke="${NAV}" stroke-width="${f(2.5 * w)}" stroke-linejoin="round"/>`;
  const motes = [[-16, -6, 2.5], [6, -16, 2], [18, -4, 2.2], [-4, -28, 1.6], [12, -36, 1.4]]
    .map(([x, y, r]) => `<circle cx="${x}" cy="${f(y * w)}" r="${r}" fill="${NAV_LIGHT}" opacity="0.8"/>`)
    .join("");
  return svg(`${shade(40, 13, 22)}${groundGlow(active ? 44 : 34, NAV, 16, active ? 0.4 : 0.25)}${active ? pillar(NAV, -46, 16, 24) : ""}${crack}${glowCrack}<path d="M-24 6 Q-10 -6 0 2 Q10 -8 24 4" fill="none" stroke="${NAV}" stroke-width="5" opacity="0.25" stroke-linecap="round"/>${motes}`);
}

/** Камень-указатель: стоячий камень с вырезанной стрелой-руной; действует — руна светится и расходится кольцом. */
function waystone(active) {
  return svg(`${shade(22, 8, 40)}${active ? `<circle cx="0" cy="34" r="30" fill="none" stroke="${WARD}" stroke-width="2.5" opacity="0.7"/><circle cx="0" cy="34" r="20" fill="none" stroke="${WARD}" stroke-width="2" opacity="0.45"/>` : ""}
<path d="M-16 40 L-13 -26 Q-4 -42 8 -36 Q15 -30 16 -18 L17 40 Z" fill="#5b6280"/><path d="M-11 38 L-9 -22" stroke="#6c7393" stroke-width="4"/>
<path d="M2 -18 L2 14 M2 -18 L-6 -8 M2 -18 L10 -8 M-4 14 L8 14" fill="none" stroke="${active ? WARD_LIGHT : "#3f4562"}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
${active ? glow(12, WARD, -4, 0.3) : ""}`);
}

/** Блуждающий огонёк: бирюзовая искра с хвостом; `phase` — шаг мерцания. */
function wisp(phase) {
  const r = 7 + phase * 1.5;
  return svg(`${glow(r * 3, WARD, 0, 0.18)}${glow(r * 1.8, WARD, 0, 0.3)}<circle cx="0" cy="0" r="${r}" fill="${WARD_LIGHT}"/><path d="M-6 6 Q-18 14 -30 10 Q-18 8 -10 2" fill="${WARD}" opacity="0.6"/>`);
}
