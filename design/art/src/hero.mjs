// Герой — Хранитель рубежа. Светлый плащ с капюшоном (роль «герой — белый»),
// посох с бирюзовым оберегом (роль «своё оружие — бирюза»), тёплый шарф —
// единственная тёплая деталь, связывает героя с огнём очага.
//
// Контур — признак героя: у врагов его нет (design/README.md, «Вид боя»),
// поэтому тёмный кант читается как «это я» даже в толпе красных тел.

import { HERO as H } from "./palette.mjs";
import { twoTone } from "./creatures.mjs";

const TAU = Math.PI * 2;
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
  const hood = `<path d="M-14 ${f(-14 + y)} Q-16 ${f(-40 + y)} 2 ${f(-40 + y)} Q18 ${f(-40 + y)} 16 ${f(-20 + y)} Q14 ${f(-10 + y)} 2 ${f(-9 + y)} Q-10 ${f(-8 + y)} -14 ${f(-14 + y)} Z"/>`;
  const eyeMark =
    eyes === "open"
      ? `<ellipse cx="10" cy="${f(-23 + y)}" rx="1.7" ry="2.3" fill="${H.edge}"/><ellipse cx="4" cy="${f(-23 + y)}" rx="1.5" ry="2.1" fill="${H.edge}"/>`
      : `<path d="M2 ${f(-22 + y)} h4 M8 ${f(-22 + y)} h4" stroke="${H.edge}" stroke-width="1.6" stroke-linecap="round"/>`;

  const staffX = 18;
  const staff = `<g transform="rotate(${f(staffAngle)} ${staffX} ${f(8 + y)})">
<path d="M${staffX} ${f(-30 + y)} L${staffX + 2} ${f(34 + y)}" stroke="${H.staff}" stroke-width="3.6" stroke-linecap="round"/>
<circle cx="${staffX}" cy="${f(-34 + y)}" r="${f(9 + breath)}" fill="${H.ward}" opacity="0.3"/>
<path d="M${staffX} ${f(-42 + y)} L${staffX + 6} ${f(-34 + y)} L${staffX} ${f(-26 + y)} L${staffX - 6} ${f(-34 + y)} Z" fill="${H.ward}"/>
<path d="M${staffX} ${f(-40 + y)} L${staffX + 2.5} ${f(-35 + y)} L${staffX} ${f(-32 + y)} Z" fill="${H.wardLight}"/>
</g>`;

  return `<g opacity="${f(fade)}" transform="translate(0 32) scale(1 ${f(squash)}) translate(0 -32) rotate(${f(lean)} 0 32)">
${legBack}${legFront}
${twoTone(cloak, H.cloak, H.cloakShade, -3, -2)}
<path d="M-14 ${f(24 + y)} Q-2 ${f(28 + y)} 12 ${f(23 + y)}" fill="none" stroke="${H.cloakDeep}" stroke-width="2" opacity="0.7"/>
${twoTone(hood, H.cloak, H.cloakShade, -2, -2)}
<path d="M0 ${f(-30 + y)} Q14 ${f(-32 + y)} 14 ${f(-20 + y)} Q12 ${f(-14 + y)} 2 ${f(-15 + y)} Q-2 ${f(-22 + y)} 0 ${f(-30 + y)} Z" fill="${H.skin}"/>
<path d="M2 ${f(-15 + y)} Q8 ${f(-14 + y)} 13 ${f(-18 + y)}" fill="none" stroke="${H.skinShade}" stroke-width="2"/>
${eyeMark}
<path d="M-11 ${f(-12 + y)} Q2 ${f(-6 + y)} 13 ${f(-12 + y)} L12 ${f(-6 + y)} Q2 ${f(0 + y)} -10 ${f(-6 + y)} Z" fill="${H.scarf}"/>
<path d="M-9 ${f(-8 + y)} Q${f(-20 - hem)} ${f(-6 + y)} ${f(-26 - hem * 1.5)} ${f(2 + y + w * 2)} L${f(-18 - hem)} ${f(-1 + y)} Z" fill="${H.scarfShade}"/>
${staff}
<path d="M10 ${f(-4 + y)} Q16 ${f(2 + y)} ${staffX + 1} ${f(4 + y)}" stroke="${H.cloakShade}" stroke-width="6" stroke-linecap="round" fill="none"/>
</g>`;
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

export const HERO_DEFS = `<filter id="heroEdge" x="-50%" y="-50%" width="200%" height="200%">
<feMorphology in="SourceAlpha" operator="dilate" radius="2.2" result="d"/>
<feFlood flood-color="${H.edge}"/><feComposite in2="d" operator="in" result="o"/>
<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

/** Радиус героя в игровых единицах — тот же, что у фигуры-заглушки (SimConfig). */
export const HERO_RADIUS = 10;
