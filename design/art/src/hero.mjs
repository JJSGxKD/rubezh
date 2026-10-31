// Герой — Хранитель рубежа. Светлый плащ с капюшоном (роль «герой — белый»),
// посох с бирюзовым оберегом (роль «своё оружие — бирюза»), тёплый шарф —
// единственная тёплая деталь, связывает героя с огнём очага.
//
// Контур — признак героя: у врагов его нет (design/README.md, «Вид боя»),
// поэтому тёмный кант читается как «это я» даже в толпе красных тел.

import { HERO } from "./palette.mjs";
import { twoTone } from "./creatures.mjs";

const TAU = Math.PI * 2;

/**
 * Палитра, которой рисуются кадры. Облик героя (`HERO_SKINS`) — та же поза
 * другой палитрой: рисунок не повторяется, и облики не расходятся с героем
 * по пропорциям.
 */
let H = HERO;

/** Нарисовать кадры героя другой палитрой: `draw` вызывается внутри. */
export function withHeroPalette(palette, draw) {
  const previous = H;
  H = { ...HERO, ...palette };
  try {
    return draw();
  } finally {
    H = previous;
  }
}

/** Фильтр канта — с цветом канта текущей палитры. */
export function heroDefs() {
  return `<filter id="heroEdge" x="-50%" y="-50%" width="200%" height="200%">
<feMorphology in="SourceAlpha" operator="dilate" radius="2.2" result="d"/>
<feFlood flood-color="${H.edge}"/><feComposite in2="d" operator="in" result="o"/>
<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
}
const f = (n) => (Math.round(n * 10) / 10).toString();

/**
 * Поза героя. `walk` — фаза шага 0…1 или null (стоит), `breath` — вдох 0…1,
 * `lean` — наклон корпуса в градусах (ранение, смерть), `drop` — осадка вниз.
 */
function pose({ walk = null, breath = 0, lean = 0, drop = 0, staffAngle = 0, eyes = "open", squash = 1, fade = 1 }) {
  const w = walk === null ? 0 : Math.sin(walk * TAU);
  const bob = walk === null ? breath * 1.2 : -Math.abs(w) * 2.5;
  const y = bob + drop;
  const hem = walk === null ? breath * 1.5 : w * 3;

  const legBack = `<path d="M${f(-5 - w * 7)} ${f(32)} L${f(-4 - w * 4)} ${f(18 + y)}" stroke="${H.boots}" stroke-width="7" stroke-linecap="round"/>`;
  const legFront = `<path d="M${f(5 + w * 7)} ${f(32)} L${f(4 + w * 4)} ${f(18 + y)}" stroke="${H.boots}" stroke-width="7" stroke-linecap="round"/>`;

  const cloak = `<path d="M-9 ${f(-10 + y)} Q-18 ${f(10 + y)} ${f(-21 - hem)} ${f(28 + y)} Q-4 ${f(33 + y)} ${f(17 - hem * 0.5)} ${f(27 + y)} Q14 ${f(8 + y)} 9 ${f(-10 + y)} Z"/>`;
  const eyeColor = H.eyes ?? H.edge;
  const eyeMark =
    eyes === "open"
      ? `<ellipse cx="10" cy="${f(-23 + y)}" rx="1.7" ry="2.3" fill="${eyeColor}"/><ellipse cx="4" cy="${f(-23 + y)}" rx="1.5" ry="2.1" fill="${eyeColor}"/>`
      : `<path d="M2 ${f(-22 + y)} h4 M8 ${f(-22 + y)} h4" stroke="${H.edge}" stroke-width="1.6" stroke-linecap="round"/>`;

  const staffX = 18;
  const staff = `<g transform="rotate(${f(staffAngle)} ${staffX} ${f(8 + y)})">
${prop(H.prop ?? "staff", staffX, y, breath)}
</g>`;

  return `<g opacity="${f(fade)}" transform="translate(0 32) scale(1 ${f(squash)}) translate(0 -32) rotate(${f(lean)} 0 32)">
${legBack}${legFront}
${twoTone(cloak, H.cloak, H.cloakShade, -3, -2)}
<path d="M-14 ${f(24 + y)} Q-2 ${f(28 + y)} 12 ${f(23 + y)}" fill="none" stroke="${H.cloakDeep}" stroke-width="2" opacity="0.7"/>
${head(H.head ?? "hood", y, eyeMark)}
<path d="M-11 ${f(-12 + y)} Q2 ${f(-6 + y)} 13 ${f(-12 + y)} L12 ${f(-6 + y)} Q2 ${f(0 + y)} -10 ${f(-6 + y)} Z" fill="${H.scarf}"/>
<path d="M-9 ${f(-8 + y)} Q${f(-20 - hem)} ${f(-6 + y)} ${f(-26 - hem * 1.5)} ${f(2 + y + w * 2)} L${f(-18 - hem)} ${f(-1 + y)} Z" fill="${H.scarfShade}"/>
${staff}
<path d="M10 ${f(-4 + y)} Q16 ${f(2 + y)} ${staffX + 1} ${f(4 + y)}" stroke="${H.cloakShade}" stroke-width="6" stroke-linecap="round" fill="none"/>
</g>`;
}

/** Лицо — общее у всех голов: облик меняет то, что вокруг него. */
function face(y) {
  return `<path d="M0 ${f(-30 + y)} Q14 ${f(-32 + y)} 14 ${f(-20 + y)} Q12 ${f(-14 + y)} 2 ${f(-15 + y)} Q-2 ${f(-22 + y)} 0 ${f(-30 + y)} Z" fill="${H.skin}"/>
<path d="M2 ${f(-15 + y)} Q8 ${f(-14 + y)} 13 ${f(-18 + y)}" fill="none" stroke="${H.skinShade}" stroke-width="2"/>`;
}

/**
 * Голова облика (design/art/direction-v2.md §7.3): капюшон хранителя, шлем
 * витязя, венок ведуньи, волчья шкура охотницы, княжья шапка, колпак
 * скомороха. Лицо и глаза — те же: герой узнаётся в любом облике.
 */
function head(kind, y, eyeMark) {
  const Y = (n) => f(n + y);
  if (kind === "helm") {
    const dome = `<path d="M-12 ${Y(-25)} Q-12 ${Y(-41)} 3 ${Y(-42)} Q17 ${Y(-41)} 17 ${Y(-25)} Z"/>`;
    return `${twoTone(`<path d="M-15 ${Y(-12)} Q-17 ${Y(-28)} -6 ${Y(-29)} L15 ${Y(-21)} Q15 ${Y(-9)} 2 ${Y(-8)} Q-11 ${Y(-7)} -15 ${Y(-12)} Z"/>`, H.mail, H.mailShade, -2, -2)}
${face(y)}${eyeMark}
${twoTone(dome, H.helm, H.helmShade, -2, -2)}
<path d="M1 ${Y(-41)} L3 ${Y(-51)} L5 ${Y(-41)} Z" fill="${H.trim}"/>
<path d="M-13 ${Y(-28)} H18 V${Y(-24)} H-13 Z" fill="${H.trim}"/>
<path d="M8 ${Y(-25)} V${Y(-16)}" stroke="${H.trim}" stroke-width="2.4" stroke-linecap="round"/>`;
  }
  if (kind === "wreath") {
    const flowers = [[-11, -30, 0], [-5, -35, 1], [2, -37, 0], [9, -36, 1], [15, -31, 0]];
    return `<path d="M-13 ${Y(-16)} Q-17 ${Y(-37)} 2 ${Y(-38)} Q17 ${Y(-37)} 16 ${Y(-25)} L13 ${Y(-22)} Q8 ${Y(-30)} 0 ${Y(-30)} Q-5 ${Y(-20)} -6 ${Y(-7)} Q-12 ${Y(-7)} -13 ${Y(-16)} Z" fill="${H.hair}"/>
${[0, 1, 2, 3].map((k) => `<circle cx="${f(-11 - k * 1.2)}" cy="${Y(-6 + k * 6)}" r="${f(3.4 - k * 0.3)}" fill="${H.hair}"/>`).join("")}
${face(y)}${eyeMark}
${flowers.map(([x, fy, alt]) => `<circle cx="${f(x - 2)}" cy="${Y(fy + 2)}" r="2.6" fill="${H.leaf}"/><circle cx="${x}" cy="${Y(fy)}" r="3.4" fill="${alt === 1 ? H.flowerAlt : H.flower}"/><circle cx="${x}" cy="${Y(fy)}" r="1.2" fill="${H.flowerHeart}"/>`).join("")}`;
  }
  if (kind === "pelt") {
    const hood = `<path d="M-14 ${Y(-14)} Q-16 ${Y(-40)} 2 ${Y(-40)} Q18 ${Y(-40)} 16 ${Y(-20)} Q14 ${Y(-10)} 2 ${Y(-9)} Q-10 ${Y(-8)} -14 ${Y(-14)} Z"/>`;
    return `<path d="M-8 ${Y(-37)} L-5 ${Y(-49)} L1 ${Y(-39)} Z" fill="${H.peltShade}"/><path d="M5 ${Y(-39)} L11 ${Y(-49)} L14 ${Y(-35)} Z" fill="${H.pelt}"/>
${twoTone(hood, H.pelt, H.peltShade, -2, -2)}
${face(y)}${eyeMark}
<path d="M-2 ${Y(-34)} Q10 ${Y(-40)} 21 ${Y(-31)} Q13 ${Y(-27)} 2 ${Y(-29)} Z" fill="${H.peltShade}"/>
<circle cx="20.5" cy="${Y(-31)}" r="1.6" fill="${H.edge}"/>
<path d="M-12 ${Y(-12)} L-9 ${Y(-6)} L-6 ${Y(-11)} L-3 ${Y(-5)} L0 ${Y(-10)}" fill="none" stroke="${H.peltShade}" stroke-width="1.6" stroke-linejoin="round"/>`;
  }
  if (kind === "cap") {
    const dome = `<path d="M-11 ${Y(-27)} Q-10 ${Y(-42)} 3 ${Y(-43)} Q15 ${Y(-42)} 15 ${Y(-27)} Z"/>`;
    return `${face(y)}${eyeMark}
${twoTone(dome, H.capTop, H.capShade, -2, -2)}
<path d="M3 ${Y(-43)} V${Y(-49)} M0 ${Y(-46)} H6" stroke="${H.trim}" stroke-width="2" stroke-linecap="round"/>
<path d="M3 ${Y(-41)} L6 ${Y(-37)} L3 ${Y(-33)} L0 ${Y(-37)} Z" fill="${H.ward}"/>
<path d="M-14 ${Y(-30)} Q2 ${Y(-34)} 18 ${Y(-30)} L18 ${Y(-24)} Q2 ${Y(-28)} -14 ${Y(-24)} Z" fill="${H.fur}"/>
${[-10, -4, 3, 10, 15].map((x) => `<circle cx="${x}" cy="${Y(-27)}" r="0.9" fill="${H.furDot}"/>`).join("")}`;
  }
  if (kind === "jester") {
    return `${face(y)}${eyeMark}
<path d="M-12 ${Y(-26)} Q-22 ${Y(-34)} -19 ${Y(-47)} Q-10 ${Y(-36)} 3 ${Y(-31)} Z" fill="${H.capA}"/>
<path d="M2 ${Y(-31)} Q12 ${Y(-42)} 23 ${Y(-45)} Q22 ${Y(-32)} 16 ${Y(-25)} Z" fill="${H.capB}"/>
<path d="M-13 ${Y(-28)} Q2 ${Y(-33)} 17 ${Y(-27)} L17 ${Y(-23)} Q2 ${Y(-28)} -13 ${Y(-24)} Z" fill="${H.trim}"/>
<circle cx="-19" cy="${Y(-48)}" r="2.6" fill="${H.trim}"/><circle cx="23.5" cy="${Y(-46)}" r="2.6" fill="${H.trim}"/>`;
  }
  const hood = `<path d="M-14 ${Y(-14)} Q-16 ${Y(-40)} 2 ${Y(-40)} Q18 ${Y(-40)} 16 ${Y(-20)} Q14 ${Y(-10)} 2 ${Y(-9)} Q-10 ${Y(-8)} -14 ${Y(-14)} Z"/>`;
  return `${twoTone(hood, H.cloak, H.cloakShade, -2, -2)}
${face(y)}
${eyeMark}`;
}

/**
 * Предмет в руке облика: посох с оберегом, копьё, посох-крюк с фонарём, лук,
 * меч, посох скомороха с лентами. Только облик — бьёт герой оружием забега.
 */
function prop(kind, x, y, breath) {
  const Y = (n) => f(n + y);
  if (kind === "spear") {
    return `<path d="M${x} ${Y(-34)} L${x + 2} ${Y(34)}" stroke="${H.staff}" stroke-width="3.2" stroke-linecap="round"/>
<path d="M${x} ${Y(-52)} Q${x + 5} ${Y(-43)} ${x} ${Y(-33)} Q${x - 5} ${Y(-43)} ${x} ${Y(-52)} Z" fill="${H.blade}"/>
<path d="M${x} ${Y(-50)} L${x} ${Y(-36)}" stroke="${H.bladeShade}" stroke-width="1.2"/>
<path d="M${x - 1} ${Y(-32)} q-4 4 -2 9 M${x + 1} ${Y(-32)} q3 5 0 9" stroke="${H.scarf}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
  }
  if (kind === "lantern") {
    return `<path d="M${x} ${Y(-28)} L${x + 2} ${Y(34)}" stroke="${H.staff}" stroke-width="3.4" stroke-linecap="round"/>
<path d="M${x} ${Y(-28)} Q${x - 1} ${Y(-40)} ${x + 8} ${Y(-40)} Q${x + 14} ${Y(-38)} ${x + 11} ${Y(-31)}" fill="none" stroke="${H.staff}" stroke-width="3.2" stroke-linecap="round"/>
<circle cx="${x + 11}" cy="${Y(-21)}" r="${f(10 + breath)}" fill="${H.ward}" opacity="0.28"/>
<path d="M${x + 11} ${Y(-31)} V${Y(-28)}" stroke="${H.edge}" stroke-width="1.4"/>
<path d="M${x + 7} ${Y(-28)} H${x + 15} L${x + 16} ${Y(-17)} L${x + 11} ${Y(-14)} L${x + 6} ${Y(-17)} Z" fill="${H.lanternFrame ?? H.staff}"/>
<path d="M${x + 8.5} ${Y(-26)} H${x + 13.5} L${x + 14} ${Y(-18)} L${x + 11} ${Y(-16.5)} L${x + 8} ${Y(-18)} Z" fill="${H.ward}"/>
<path d="M${x + 11} ${Y(-24)} Q${x + 13} ${Y(-21)} ${x + 11} ${Y(-19)} Q${x + 9} ${Y(-21)} ${x + 11} ${Y(-24)} Z" fill="${H.wardLight}"/>`;
  }
  if (kind === "bow") {
    return `<path d="M${x + 1} ${Y(-32)} Q${x + 17} ${Y(2)} ${x + 1} ${Y(36)}" fill="none" stroke="${H.staff}" stroke-width="3.4" stroke-linecap="round"/>
<path d="M${x + 1} ${Y(-32)} L${x + 1} ${Y(36)}" stroke="${H.string ?? "#e8e2d4"}" stroke-width="1"/>
<path d="M${x - 1} ${Y(-30)} Q${x + 6} ${Y(-36)} ${x + 4} ${Y(-26)}" fill="none" stroke="${H.scarf}" stroke-width="1.6"/>`;
  }
  if (kind === "sword") {
    return `<path d="M${x} ${Y(0)} L${x} ${Y(-40)} L${x + 2.6} ${Y(-36)} L${x + 2.6} ${Y(0)} Z" fill="${H.blade}"/>
<path d="M${x} ${Y(0)} L${x} ${Y(-40)} L${x - 2.6} ${Y(-36)} L${x - 2.6} ${Y(0)} Z" fill="${H.bladeShade}"/>
<circle cx="${x}" cy="${Y(-30)}" r="${f(8 + breath)}" fill="${H.ward}" opacity="0.18"/>
<path d="M${x - 7} ${Y(1)} H${x + 7}" stroke="${H.trim}" stroke-width="3.4" stroke-linecap="round"/>
<path d="M${x} ${Y(2)} V${Y(9)}" stroke="${H.staff}" stroke-width="3" stroke-linecap="round"/>
<circle cx="${x}" cy="${Y(11)}" r="2.4" fill="${H.trim}"/>`;
  }
  if (kind === "ribbons") {
    return `<path d="M${x} ${Y(-30)} L${x + 2} ${Y(34)}" stroke="${H.staff}" stroke-width="3.4" stroke-linecap="round"/>
<path d="M${x} ${Y(-30)} q8 2 10 10 q-6 -3 -10 -2 Z" fill="${H.capA}"/>
<path d="M${x} ${Y(-30)} q-8 4 -9 13 q4 -5 9 -7 Z" fill="${H.capB}"/>
<circle cx="${x}" cy="${Y(-33)}" r="3.6" fill="${H.trim}"/><circle cx="${x - 1}" cy="${Y(-34)}" r="1.2" fill="#fff" opacity="0.8"/>`;
  }
  return `<path d="M${x} ${Y(-30)} L${x + 2} ${Y(34)}" stroke="${H.staff}" stroke-width="3.6" stroke-linecap="round"/>
<circle cx="${x}" cy="${Y(-34)}" r="${f(9 + breath)}" fill="${H.ward}" opacity="0.3"/>
<path d="M${x} ${Y(-42)} L${x + 6} ${Y(-34)} L${x} ${Y(-26)} L${x - 6} ${Y(-34)} Z" fill="${H.ward}"/>
<path d="M${x} ${Y(-40)} L${x + 2.5} ${Y(-35)} L${x} ${Y(-32)} Z" fill="${H.wardLight}"/>`;
}

const shadow = (scale = 1) => `<ellipse cx="0" cy="34" rx="${f(18 * scale)}" ry="${f(6 * scale)}" fill="#000" opacity="0.32"/>`;

/** Кадры героя по состояниям. Ранение — один кадр отдачи: вспышку цветом даёт рендер. */
export const HERO_STATES = {
  idle: [0, 1].map((k) => () => shadow() + edge(pose({ breath: k }))),
  walk: [0, 0.25, 0.5, 0.75].map((p) => () => shadow() + edge(pose({ walk: p }))),
  hurt: [() => shadow() + edge(pose({ lean: -10, staffAngle: -14, eyes: "shut" }))],
  // Смерть — оседает на колено и рассеивается бирюзой оберега, а не падает
  // плашмя: лежачая фигура не влезает в ячейку и читалась бы как ещё живой герой.
  death: [
    () => shadow() + edge(pose({ lean: -8, drop: 2, staffAngle: -16, eyes: "shut" })),
    () => shadow(0.95) + edge(pose({ lean: -14, drop: 4, squash: 0.82, staffAngle: -34, eyes: "shut" })),
    () => shadow(0.9) + edge(pose({ lean: -18, drop: 6, squash: 0.66, staffAngle: -52, eyes: "shut", fade: 0.7 })) + motes(0.4),
    () => shadow(0.8) + edge(pose({ lean: -20, drop: 8, squash: 0.55, staffAngle: -60, eyes: "shut", fade: 0.3 })) + motes(1),
  ],
};

function motes(p) {
  return [[-10, 0.2], [6, 0.6], [14, 0.1], [-4, 0.9]]
    .map(([x, k]) => `<circle cx="${f(x)}" cy="${f(10 - (p + k) * 24)}" r="${f(3 * (1 - p * 0.5))}" fill="${H.ward}" opacity="${f(0.9 - p * 0.4)}"/>`)
    .join("");
}

/** Тёмный кант по силуэту — фильтром, чтобы он шёл по любой позе без ручной обводки. */
function edge(inner) {
  return `<g filter="url(#heroEdge)">${inner}</g>`;
}

export const HERO_DEFS = heroDefs();

export const HERO_RADIUS = 10;

/**
 * Облики героя. Первые пять — окрасы хранителя (design/art/registry.md,
 * G-05): та же поза другой палитрой. Дальше — архетипы v2
 * (design/art/direction-v2.md §7.3): своя голова (`head`) и свой предмет в
 * руке (`prop`) на той же позе — пропорции и хитбокс не расходятся. Мандат
 * v2 снял правило «герой — белый»: героя в толпе держат знак под ногами,
 * тёмный кант и тёплый акцент, а не цвет плаща. `rarity` и `source` — откуда
 * облик берётся (§7.3, «Облики»).
 */
export const HERO_SKINS = [
  { id: "keeper", name: "Хранитель", palette: {} },
  { id: "herbalist", name: "Знахарка", palette: { cloak: "#f1f6ea", cloakShade: "#c4d0b6", cloakDeep: "#8d9a7c", scarf: "#b07cf0", scarfShade: "#7e4fc0", ward: "#46d9c6" } },
  { id: "frost", name: "Зимний дозор", palette: { cloak: "#eef5ff", cloakShade: "#b9cbe6", cloakDeep: "#8199bf", scarf: "#5ccfff", scarfShade: "#2f8fc4", ward: "#b8ecff", wardLight: "#ffffff", boots: "#2f3b5c" } },
  { id: "gilded", name: "Золотой рубеж", palette: { cloak: "#fff7e2", cloakShade: "#e6cf9a", cloakDeep: "#b89a5a", scarf: "#3f6fd0", scarfShade: "#2a4c96", ward: "#ffd15c", wardLight: "#fff6c8", staff: "#5a3d2a" } },
  // Рассвет (Р155, «Набор хранителя»): небо над рубежом перед восходом —
  // персиковый плащ с сизо-розовой тенью и солнце золотым шарфом. Оберег
  // остаётся бирюзой хранителя: это его окрас, а не новый архетип. От
  // окрасов за уровни отличается тоном плаща — у них белый, травяной,
  // ледяной и сливочно-золотой.
  { id: "dawn", name: "Хранитель · рассвет", source: "Набор хранителя", palette: { cloak: "#ffe6dc", cloakShade: "#f0b4a4", cloakDeep: "#b5728a", edge: "#26182e", scarf: "#ffc23d", scarfShade: "#cf8a1c", staff: "#7a5040", boots: "#4a3352" } },
  {
    id: "vityaz", name: "Витязь", rarity: "rare", source: "уровень аккаунта",
    palette: { head: "helm", prop: "spear", cloak: "#a8463a", cloakShade: "#7a2c24", cloakDeep: "#521b16", scarf: "#d9b45a", scarfShade: "#a07e2e", mail: "#9aa2bd", mailShade: "#6c7391", helm: "#d5dbea", helmShade: "#9199b5", trim: "#e0bb5e", blade: "#eef3fb", bladeShade: "#aab3c9", staff: "#6b4a32", boots: "#3b2a24" },
  },
  {
    id: "vedunya", name: "Ведунья", rarity: "rare", source: "задания недели",
    palette: { head: "wreath", prop: "lantern", cloak: "#5e8f62", cloakShade: "#3e6a43", cloakDeep: "#2a4a2e", scarf: "#f2d16b", scarfShade: "#c2a03e", hair: "#b8642e", flower: "#ff7a9c", flowerAlt: "#fff1a6", flowerHeart: "#c9652a", leaf: "#7bc96f", ward: "#ffcf6a", wardLight: "#fff6d8", staff: "#6e4c33", lanternFrame: "#4a3a2c", boots: "#3a3022" },
  },
  {
    id: "ohotnitsa", name: "Охотница", rarity: "epic", source: "достижение",
    palette: { head: "pelt", prop: "bow", cloak: "#8a6a4a", cloakShade: "#664c33", cloakDeep: "#47331f", scarf: "#d0563d", scarfShade: "#9c3a26", pelt: "#a6aec0", peltShade: "#6f778c", staff: "#7a5236", boots: "#2f2a26" },
  },
  {
    id: "knyaz", name: "Князь", rarity: "legendary", source: "VIP",
    palette: { head: "cap", prop: "sword", cloak: "#3456b8", cloakShade: "#243d88", cloakDeep: "#17285c", scarf: "#ffd15c", scarfShade: "#c9a033", capTop: "#c63c3c", capShade: "#902828", fur: "#f1e9d8", furDot: "#2a2238", trim: "#ffd15c", blade: "#f1f5ff", bladeShade: "#b7c0da", ward: "#5ce1ff", staff: "#5a3d2a", boots: "#2a2238" },
  },
  {
    id: "skomoroh", name: "Скоморох", rarity: "epic", source: "событие",
    palette: { head: "jester", prop: "ribbons", cloak: "#e0573f", cloakShade: "#b23c2a", cloakDeep: "#7c2618", scarf: "#46d9c6", scarfShade: "#2a9f90", capA: "#ffd15c", capB: "#46d9c6", trim: "#ffb22e", staff: "#7a5236", boots: "#3a2a4a" },
  },
  {
    id: "navi", name: "Навий страж", rarity: "mythic", source: "топ сезона",
    palette: { cloak: "#2f2848", cloakShade: "#1f1a33", cloakDeep: "#14101f", edge: "#a08cf0", eyes: "#9ffcf0", scarf: "#8a5cff", scarfShade: "#5d3cc0", ward: "#b07cff", wardLight: "#f0e6ff", skin: "#c9b8e8", skinShade: "#9d8cc4", staff: "#3a2f55", boots: "#14101f" },
  },
];
