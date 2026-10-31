// Существа забега векторными рисунками с параметром кадра.
//
// Каждый рисунок — функция `draw(t, P)` → внутренность SVG в поле -50…50,
// существо смотрит вправо (влево — отражение спрайта), земля — y ≈ 42.
// `t` — доля цикла анимации 0…1, `P` — палитра (palette.mjs). Рисунок не знает
// ни размера текстуры, ни ступени, ни ранга: их добавляет сборка атласа.
//
// Правило формы: силуэт существа наследует фигуру-заглушку своего паттерна
// (круг крысы, квадрат упыря, остриё волка, кольцо ворона…), чтобы гайдбук,
// привычка игроков и «цвет по угрозе» не потеряли смысла (design/art/characters.md).

const TAU = Math.PI * 2;
const f = (n) => (Math.round(n * 10) / 10).toString();

let uid = 0;
/**
 * Плоская светотень в два тона: силуэт целиком заливается тенью, сверху —
 * тот же силуэт цветом тела со сдвигом вверх-влево, обрезанный по силуэту.
 * Тень остаётся каёмкой снизу-справа: объём без градиентов и без контура.
 */
export function twoTone(shape, fill, shade, dx = -2, dy = -3) {
  const id = `c${++uid}`;
  return `<clipPath id="${id}">${shape}</clipPath>
<g fill="${shade}">${shape}</g>
<g clip-path="url(#${id})"><g fill="${fill}" transform="translate(${f(dx)} ${f(dy)})">${shape}</g></g>`;
}

function eye(x, y, r, P, look = 1) {
  return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${P.eye}"/><circle cx="${f(x + r * 0.35 * look)}" cy="${f(y)}" r="${f(r * 0.45)}" fill="${P.pupil}"/>`;
}

function glowEye(x, y, r, P) {
  return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 1.9)}" fill="${P.eye}" opacity="0.28"/><circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${P.eye}"/>`;
}

function leg(x, y, angle, length, width, color) {
  const ex = x + Math.sin(angle) * length;
  const ey = y + Math.cos(angle) * length;
  return `<line x1="${f(x)}" y1="${f(y)}" x2="${f(ex)}" y2="${f(ey)}" stroke="${color}" stroke-width="${f(width)}" stroke-linecap="round"/>`;
}

// ───────────────────────── рядовые ─────────────────────────

/** Крыса — рой. Круг: тело-шар, голова с острой мордой, хвост хлыстом. */
function rat(t, P) {
  const w = Math.sin(t * TAU);
  const bob = -Math.abs(w) * 3;
  const body = `<ellipse cx="-4" cy="${f(12 + bob)}" rx="27" ry="21"/><circle cx="18" cy="${f(6 + bob)}" r="14"/><path d="M26 ${f(-2 + bob)} L44 ${f(9 + bob)} L27 ${f(17 + bob)} Z"/>`;
  return `
<path d="M-28 ${f(16 + bob)} Q-46 ${f(14 + bob)} -44 ${f(-2 + w * 5)}" fill="none" stroke="${P.shade}" stroke-width="4.5" stroke-linecap="round"/>
<ellipse cx="${f(-14 + w * 5)}" cy="36" rx="7" ry="4" fill="${P.deep}"/><ellipse cx="${f(10 - w * 5)}" cy="36" rx="7" ry="4" fill="${P.deep}"/>
${twoTone(body, P.body, P.shade)}
<circle cx="8" cy="${f(-8 + bob)}" r="9" fill="${P.body}"/><circle cx="8" cy="${f(-8 + bob)}" r="5" fill="${P.light}"/>
<path d="M-24 ${f(2 + bob)} Q-10 ${f(-12 + bob)} 6 ${f(-6 + bob)}" fill="none" stroke="${P.light}" stroke-width="3" stroke-linecap="round" opacity="0.8"/>
${eye(25, 3 + bob, 4, P)}
<path d="M33 ${f(13 + bob)} L36 ${f(19 + bob)} L38 ${f(12 + bob)} Z" fill="${P.bone}"/>`;
}

/** Болотный увалень — тоже рой, но тяжёлый: круглая куча тины с одним глазом. */
function shambler(t, P) {
  const w = Math.sin(t * TAU);
  const sway = w * 2.5;
  const mound = `<path d="M-38 38 Q-44 6 -24 -14 Q-6 -34 14 -26 Q36 -18 40 8 Q42 30 36 38 Z"/>`;
  return `
${twoTone(`<g transform="translate(${f(sway)} 0)">${mound}</g>`, P.body, P.shade, -3, -4)}
<path d="M${f(-30 + sway)} 38 q3 -10 6 0 M${f(-6 + sway)} 38 q3 -8 6 0 M${f(20 + sway)} 38 q3 -11 6 0" fill="${P.deep}"/>
<path d="M${f(-22 + sway)} -12 l-6 -16 M${f(-14 + sway)} -18 l-2 -18 M${f(-4 + sway)} -22 l4 -14" stroke="${P.shade}" stroke-width="3.5" stroke-linecap="round"/>
<circle cx="${f(-12 + sway)}" cy="6" r="6" fill="${P.deep}" opacity="0.5"/><circle cx="${f(-26 + sway)}" cy="20" r="4" fill="${P.deep}" opacity="0.5"/>
${eye(16 + sway, -4, 8.5, P)}${eye(30 + sway, 4, 4, P)}
<path d="M${f(10 + sway)} 18 Q${f(22 + sway)} ${f(26 + w * 2)} ${f(34 + sway)} 16" fill="none" stroke="${P.deep}" stroke-width="3" stroke-linecap="round"/>`;
}

/** Упырь — преследователь-танк. Квадрат: горбатый короб, голова низко, длинные руки. */
function ghoul(t, P, extra = "") {
  const w = Math.sin(t * TAU);
  const bob = -Math.abs(w) * 2;
  const torso = `<path d="M-26 ${f(26 + bob)} Q-36 ${f(0 + bob)} -24 ${f(-20 + bob)} Q-8 ${f(-36 + bob)} 12 ${f(-28 + bob)} Q28 ${f(-20 + bob)} 26 ${f(0 + bob)} L22 ${f(26 + bob)} Z"/>`;
  return `
<rect x="${f(-20 + w * 5)}" y="22" width="12" height="18" rx="4" fill="${P.deep}"/>
<rect x="${f(4 - w * 5)}" y="22" width="12" height="18" rx="4" fill="${P.deep}"/>
<path d="M-6 ${f(-6 + bob)} Q${f(-18 - w * 6)} 12 ${f(-12 - w * 8)} 30" fill="none" stroke="${P.shade}" stroke-width="9" stroke-linecap="round"/>
<path d="M16 ${f(2 + bob)} Q${f(30 + w * 4)} 10 ${f(28 + w * 7)} 30" fill="none" stroke="${P.shade}" stroke-width="10" stroke-linecap="round"/>
${twoTone(torso, P.body, P.shade, -3, -4)}
<path d="M-22 ${f(-10 + bob)} Q-6 ${f(-26 + bob)} 14 ${f(-20 + bob)}" fill="none" stroke="${P.light}" stroke-width="3.5" stroke-linecap="round" opacity="0.75"/>
<circle cx="-16" cy="${f(-24 + bob)}" r="3.5" fill="${P.bone}"/><circle cx="-6" cy="${f(-29 + bob)}" r="3.5" fill="${P.bone}"/><circle cx="5" cy="${f(-29 + bob)}" r="3" fill="${P.bone}"/>
${twoTone(`<circle cx="24" cy="${f(-16 + bob)}" r="12"/><path d="M22 ${f(-8 + bob)} L40 ${f(-8 + bob)} L30 ${f(2 + bob)} Z"/>`, P.body, P.shade)}
${glowEye(28, -19 + bob, 3, P)}${glowEye(20, -20 + bob, 2.5, P)}
<path d="M28 ${f(-4 + bob)} l3 4 l2 -4 l3 4 l2 -4" fill="none" stroke="${P.bone}" stroke-width="1.8"/>
<path d="M${f(22 + w * 7)} 32 l-3 8 M${f(27 + w * 7)} 33 l0 8 M${f(32 + w * 7)} 32 l4 7" stroke="${P.bone}" stroke-width="2.6" stroke-linecap="round"/>
${extra}`;
}

/** Костяной ходок — преследователь дугами. Высокий, тонкий, рёбра наружу. */
function boneWalker(t, P) {
  const w = Math.sin(t * TAU);
  const bob = -Math.abs(w) * 3;
  return `
${leg(-4, 10 + bob, w * 0.5, 30, 5, P.shade)}${leg(4, 10 + bob, -w * 0.5, 30, 5, P.body)}
<path d="M-6 ${f(12 + bob)} L-10 ${f(-14 + bob)} Q0 ${f(-22 + bob)} 12 ${f(-14 + bob)} L8 ${f(12 + bob)} Z" fill="${P.shade}"/>
<path d="M-8 ${f(-12 + bob)} h18 M-8 ${f(-5 + bob)} h18 M-7 ${f(2 + bob)} h15" stroke="${P.light}" stroke-width="3" stroke-linecap="round"/>
<path d="M-2 ${f(-14 + bob)} V${f(12 + bob)}" stroke="${P.body}" stroke-width="3"/>
<path d="M-6 ${f(-16 + bob)} L${f(-18 - w * 8)} ${f(6 + bob)}" stroke="${P.shade}" stroke-width="4.5" stroke-linecap="round"/>
<path d="M8 ${f(-16 + bob)} L${f(26 + w * 6)} ${f(-4 + bob)}" stroke="${P.body}" stroke-width="4.5" stroke-linecap="round"/>
<path d="M${f(26 + w * 6)} ${f(-4 + bob)} l6 -3 M${f(26 + w * 6)} ${f(-4 + bob)} l6 3" stroke="${P.light}" stroke-width="2.5" stroke-linecap="round"/>
${twoTone(`<path d="M-8 ${f(-24 + bob)} Q-10 ${f(-44 + bob)} 6 ${f(-44 + bob)} Q20 ${f(-44 + bob)} 18 ${f(-28 + bob)} L14 ${f(-20 + bob)} L-2 ${f(-20 + bob)} Z"/>`, P.light, P.body)}
<circle cx="9" cy="${f(-32 + bob)}" r="4" fill="${P.pupil}"/><circle cx="9" cy="${f(-32 + bob)}" r="1.7" fill="${P.eye}"/>
<path d="M3 ${f(-23 + bob)} v-4 M7 ${f(-23 + bob)} v-4 M11 ${f(-23 + bob)} v-4" stroke="${P.pupil}" stroke-width="1.5"/>`;
}

/** Блуждающий огонёк — стрелок. Треугольник: язык пламени остриём вверх. */
function wisp(t, P) {
  const w = Math.sin(t * TAU);
  const w2 = Math.sin(t * TAU * 2);
  const bob = w * 3;
  const tip = w2 * 5;
  const flame = (k, dy) =>
    `<path d="M${f(tip * k)} ${f(-44 * k + dy)} C${f(12 * k)} ${f(-24 * k + dy)} ${f(26 * k)} ${f(-8 * k + dy)} ${f(24 * k)} ${f(10 * k + dy)} C${f(22 * k)} ${f(28 * k + dy)} ${f(10 * k)} ${f(36 * k + dy)} 0 ${f(36 * k + dy)} C${f(-10 * k)} ${f(36 * k + dy)} ${f(-22 * k)} ${f(28 * k + dy)} ${f(-24 * k)} ${f(10 * k + dy)} C${f(-26 * k)} ${f(-8 * k + dy)} ${f(-12 * k)} ${f(-24 * k + dy)} ${f(tip * k)} ${f(-44 * k + dy)} Z"/>`;
  const ember = (phase, x) => {
    const p = (t + phase) % 1;
    return `<circle cx="${f(x + Math.sin(p * TAU) * 4)}" cy="${f(-30 - p * 18 + bob)}" r="${f(2.6 * (1 - p))}" fill="${P.light}" opacity="${f(1 - p)}"/>`;
  };
  return `
<ellipse cx="0" cy="44" rx="${f(14 - bob)}" ry="3" fill="${P.body}" opacity="0.25"/>
${twoTone(flame(1, bob), P.body, P.shade, -3, -2)}
<g fill="${P.light}">${flame(0.55, bob + 8)}</g>
<ellipse cx="-7" cy="${f(10 + bob)}" rx="4" ry="5.5" fill="${P.pupil}"/><ellipse cx="7" cy="${f(10 + bob)}" rx="4" ry="5.5" fill="${P.pupil}"/>
<circle cx="-6" cy="${f(9 + bob)}" r="1.6" fill="${P.eye}"/><circle cx="8" cy="${f(9 + bob)}" r="1.6" fill="${P.eye}"/>
<path d="M-12 ${f(2 + bob)} L-3 ${f(5 + bob)} M12 ${f(2 + bob)} L3 ${f(5 + bob)}" stroke="${P.pupil}" stroke-width="2.6" stroke-linecap="round"/>
<path d="M-5 ${f(22 + bob)} L-2 ${f(19 + bob)} L1 ${f(22 + bob)} L4 ${f(19 + bob)} L6 ${f(22 + bob)}" fill="none" stroke="${P.pupil}" stroke-width="2" stroke-linejoin="round"/>
${ember(0, -10)}${ember(0.5, 12)}`;
}

/** Волк — рывок. Остриё: длинное тело, морда клином вперёд, уши назад. */
function wolf(t, P) {
  const a = Math.sin(t * TAU);
  const bob = -Math.abs(Math.cos(t * TAU)) * 3;
  const legs =
    leg(-20, 6 + bob, -a * 0.7, 22, 5.5, P.deep) +
    leg(-14, 6 + bob, -a * 0.7 + 0.4, 22, 5.5, P.shade) +
    leg(12, 6 + bob, a * 0.7, 22, 5.5, P.deep) +
    leg(18, 6 + bob, a * 0.7 - 0.4, 22, 5.5, P.shade);
  const body = `<path d="M-30 ${f(2 + bob)} Q-26 ${f(-14 + bob)} -4 ${f(-12 + bob)} L12 ${f(-14 + bob)} L24 ${f(-20 + bob)} L46 ${f(-2 + bob)} L28 ${f(4 + bob)} L18 ${f(12 + bob)} Q-6 ${f(16 + bob)} -24 ${f(12 + bob)} Z"/>`;
  return `
${legs}
<path d="M-28 ${f(0 + bob)} Q-44 ${f(-8 - a * 4)} -48 ${f(6 - a * 4)} Q-38 ${f(4 + bob)} -26 ${f(8 + bob)} Z" fill="${P.shade}"/>
${twoTone(body, P.body, P.shade, -2, -3)}
<path d="M18 ${f(-16 + bob)} L22 ${f(-34 + bob)} L30 ${f(-18 + bob)} Z" fill="${P.body}"/><path d="M21 ${f(-18 + bob)} L23 ${f(-28 + bob)} L27 ${f(-18 + bob)} Z" fill="${P.light}"/>
<path d="M-22 ${f(-8 + bob)} l4 -7 l3 6 l4 -7 l3 7 l4 -6 l2 6" fill="${P.light}" opacity="0.85"/>
<path d="M26 ${f(-10 + bob)} L36 ${f(-7 + bob)} L27 ${f(-5 + bob)} Z" fill="${P.eye}"/>
<path d="M30 ${f(2 + bob)} l3 4 l2 -4 l3 3" fill="none" stroke="${P.bone}" stroke-width="1.8"/>`;
}

/** Ворон — кольцо. Крылья раскрыты дугой, тело маленькое, клюв вперёд. */
function crow(t, P) {
  const w = Math.sin(t * TAU);
  const tipY = -26 + w * 16;
  const wing = (side) => {
    const s = side;
    return `<path d="M${f(-4)} ${f(-2)} Q${f(-14)} ${f(tipY * 0.6 * s)} ${f(-34)} ${f(tipY * s)} L${f(-28)} ${f((tipY + 8) * s)} L${f(-36)} ${f((tipY + 12) * s)} L${f(-26)} ${f((tipY + 16) * s)} L${f(-30)} ${f((tipY + 22) * s)} Q${f(-12)} ${f(8 * s)} 4 4 Z"/>`;
  };
  return `
<g transform="translate(4 4) scale(1.18)">
<g fill="${P.shade}">${wing(-1)}</g>
<path d="M-18 0 L-40 -10 L-36 0 L-44 6 L-36 10 L-40 18 L-16 8 Z" fill="${P.shade}"/>
${twoTone(`<ellipse cx="0" cy="2" rx="19" ry="12"/><circle cx="17" cy="-5" r="10"/>`, P.body, P.shade)}
<g fill="${P.body}">${wing(1)}</g>
<path d="M${f(-8)} 6 Q${f(-16)} ${f(-tipY * 0.4)} ${f(-26)} ${f(-tipY * 0.8)}" fill="none" stroke="${P.light}" stroke-width="2.5" stroke-linecap="round" opacity="0.7"/>
<path d="M23 -7 L36 -2 L23 1 Z" fill="${P.bone}"/>
${glowEye(18, -6, 2.6, P)}
</g>`;
}

/** Бес-подрывник. Шестиугольник: бочонок пороха в обнимку, фитиль искрит. */
function imp(t, P) {
  const w = Math.sin(t * TAU);
  const bob = -Math.abs(w) * 3;
  const spark = 1 + 0.5 * Math.sin(t * TAU * 4);
  const keg = `<path d="M${f(4)} ${f(-6 + bob)} L22 ${f(-6 + bob)} L32 ${f(12 + bob)} L22 ${f(30 + bob)} L4 ${f(30 + bob)} L-6 ${f(12 + bob)} Z"/>`;
  return `
${leg(-14, 18 + bob, w * 0.6, 18, 5, P.deep)}${leg(-4, 18 + bob, -w * 0.6, 18, 5, P.shade)}
${twoTone(`<ellipse cx="-12" cy="${f(6 + bob)}" rx="16" ry="18"/>`, P.body, P.shade)}
<path d="M-26 ${f(14 + bob)} Q-40 ${f(20 + w * 3)} -38 ${f(4 + w * 3)}" fill="none" stroke="${P.shade}" stroke-width="3" stroke-linecap="round"/><path d="M-40 ${f(2 + w * 3)} l-4 -4 l6 0 Z" fill="${P.shade}"/>
${twoTone(`<circle cx="-8" cy="${f(-18 + bob)}" r="14"/>`, P.body, P.shade)}
<path d="M-18 ${f(-28 + bob)} L-24 ${f(-44 + bob)} L-12 ${f(-31 + bob)} Z M0 ${f(-30 + bob)} L4 ${f(-46 + bob)} L8 ${f(-27 + bob)} Z" fill="${P.bone}"/>
${glowEye(-2, -20 + bob, 3, P)}${glowEye(-12, -21 + bob, 2.4, P)}
<path d="M-12 ${f(-11 + bob)} Q-4 ${f(-6 + bob)} 4 ${f(-12 + bob)}" fill="none" stroke="${P.pupil}" stroke-width="2.2" stroke-linecap="round"/>
${twoTone(keg, P.deep, "#1d0b22")}
<path d="M-4 ${f(4 + bob)} H30 M-4 ${f(20 + bob)} H30" stroke="${P.body}" stroke-width="3"/>
<path d="M14 ${f(-6 + bob)} Q16 ${f(-16 + bob)} 22 ${f(-18 + bob)}" fill="none" stroke="${P.bone}" stroke-width="2"/>
<circle cx="23" cy="${f(-19 + bob)}" r="${f(5 * spark)}" fill="#ffe066" opacity="0.4"/><circle cx="23" cy="${f(-19 + bob)}" r="${f(2.4 * spark)}" fill="#fff6c8"/>
<path d="M-2 ${f(0 + bob)} Q4 ${f(10 + bob)} 6 ${f(18 + bob)}" fill="none" stroke="${P.body}" stroke-width="6" stroke-linecap="round"/>`;
}

/** Слизень — делящийся. Два шара: большой позади, малый впереди, сам вот-вот распадётся. */
function slime(t, P) {
  const w = Math.sin(t * TAU);
  const sx = 1 + 0.07 * w;
  const sy = 1 - 0.08 * w;
  const blobs = `<path d="M-40 38 Q-44 -6 -14 -12 Q12 -16 14 14 Q16 34 6 38 Z"/><path d="M0 38 Q-2 6 20 4 Q42 4 42 26 Q42 36 38 38 Z"/>`;
  return `
<g transform="translate(0 38) scale(${f(sx)} ${f(sy)}) translate(0 -38)">
${twoTone(blobs, P.body, P.shade, -3, -3)}
<path d="M-6 -4 Q2 4 4 16" fill="none" stroke="${P.deep}" stroke-width="2.5" stroke-linecap="round" opacity="0.6"/>
<ellipse cx="-24" cy="-2" rx="7" ry="4" fill="${P.light}" opacity="0.85" transform="rotate(-25 -24 -2)"/>
<ellipse cx="18" cy="10" rx="5" ry="3" fill="${P.light}" opacity="0.85" transform="rotate(-20 18 10)"/>
<circle cx="-30" cy="18" r="3" fill="${P.deep}" opacity="0.45"/><circle cx="-14" cy="26" r="2" fill="${P.deep}" opacity="0.45"/>
${eye(22, 18, 4.5, P)}${eye(33, 19, 3.5, P)}
<path d="M24 30 Q30 33 36 29" fill="none" stroke="${P.pupil}" stroke-width="2" stroke-linecap="round"/>
</g>`;
}

/** Нетопыри — пролетающий рой. Четыре луча: два крыла, уши и хвост. */
function bats(t, P) {
  const w = Math.sin(t * TAU);
  const up = w * 14;
  // Крыло с фестонами по заднему краю: запястье, кончик и две перепонки между пальцами.
  const wing = (s) => {
    const wx = -16, wy = (-26 - up) * s;
    const tx = -40, ty = (-20 - up * 0.6) * s;
    return {
      membrane: `<path d="M-2 ${f(-2 * s)} L${wx} ${f(wy)} L${tx} ${f(ty)} Q${f(-34)} ${f(-8 * s)} ${f(-28)} ${f((-10 - up * 0.2) * s)} Q${f(-24)} ${f(-2 * s)} ${f(-17)} ${f((-5 - up * 0.1) * s)} Q${f(-12)} ${f(1 * s)} -6 ${f(3 * s)} Z"/>`,
      bones: `M-2 ${f(-2 * s)} L${wx} ${f(wy)} L${tx} ${f(ty)} M${wx} ${f(wy)} L-28 ${f((-10 - up * 0.2) * s)} M${wx} ${f(wy)} L-17 ${f((-5 - up * 0.1) * s)}`,
    };
  };
  const back = wing(-1);
  const front = wing(1);
  return `
<g transform="translate(8 2) rotate(-8)">
<g fill="${P.deep}">${back.membrane}</g>
<path d="${back.bones}" fill="none" stroke="${P.shade}" stroke-width="2" stroke-linecap="round"/>
${twoTone(`<ellipse cx="0" cy="0" rx="13" ry="9"/><circle cx="14" cy="-3" r="8"/><path d="M10 -8 L12 -20 L17 -10 Z M16 -9 L22 -19 L22 -7 Z"/>`, P.body, P.shade)}
<g fill="${P.shade}">${front.membrane}</g>
<path d="${front.bones}" fill="none" stroke="${P.body}" stroke-width="2.2" stroke-linecap="round"/>
<path d="M-12 4 L-24 8 L-14 0" fill="${P.shade}"/>
${glowEye(18, -4, 2.2, P)}
<path d="M18 2 l1 4 l2 -4" fill="none" stroke="${P.bone}" stroke-width="1.5"/>
</g>`;
}

// ───────────────────────── элита ─────────────────────────

/** Упырь-вожак: тот же упырь, но с костяным гребнем и цепью — вожак, а не новый вид. */
function eliteGhoul(t, P) {
  const bob = -Math.abs(Math.sin(t * TAU)) * 2;
  const crest = `<path d="M-24 ${f(-14 + bob)} L-30 ${f(-34 + bob)} L-16 ${f(-24 + bob)} L-14 ${f(-44 + bob)} L-4 ${f(-30 + bob)} L4 ${f(-46 + bob)} L8 ${f(-30 + bob)} L18 ${f(-38 + bob)} L16 ${f(-22 + bob)}" fill="${P.bone}"/>
<path d="M-20 ${f(10 + bob)} q6 6 12 0 q6 6 12 0 q6 6 12 0" fill="none" stroke="${P.bone}" stroke-width="2.6" opacity="0.9"/>`;
  return ghoul(t, P, crest);
}

/** Могильный рыцарь: таран с копьём — остриё рывкового паттерна стало наконечником. */
function graveKnight(t, P) {
  const w = Math.sin(t * TAU);
  const bob = -Math.abs(w) * 2;
  return `
${leg(-10, 14 + bob, w * 0.5, 24, 7, P.deep)}${leg(2, 14 + bob, -w * 0.5, 24, 7, P.shade)}
<path d="M-22 ${f(-6 + bob)} Q-36 ${f(6 + w * 3)} -34 ${f(24 + w * 4)} L-22 ${f(16 + bob)} Z" fill="${P.deep}"/>
${twoTone(`<path d="M-20 ${f(18 + bob)} L-24 ${f(-14 + bob)} Q-6 ${f(-24 + bob)} 12 ${f(-14 + bob)} L10 ${f(18 + bob)} Z"/>`, P.body, P.shade)}
<path d="M-18 ${f(-4 + bob)} H8 M-18 ${f(6 + bob)} H8" stroke="${P.shade}" stroke-width="2.5"/>
${twoTone(`<path d="M-14 ${f(-20 + bob)} Q-14 ${f(-42 + bob)} 2 ${f(-42 + bob)} Q16 ${f(-42 + bob)} 16 ${f(-24 + bob)} L14 ${f(-16 + bob)} L-12 ${f(-16 + bob)} Z"/>`, P.light, P.body)}
<path d="M-2 ${f(-31 + bob)} H16" stroke="${P.pupil}" stroke-width="3.5"/><circle cx="10" cy="${f(-31 + bob)}" r="1.8" fill="${P.eye}"/>
<path d="M-8 ${f(-42 + bob)} Q-20 ${f(-54 + w * 3)} -30 ${f(-44 + w * 3)}" fill="none" stroke="${P.body}" stroke-width="5" stroke-linecap="round"/>
<path d="M-6 ${f(-2 + bob)} L50 ${f(-8 + bob)}" stroke="${P.bone}" stroke-width="4" stroke-linecap="round"/>
<path d="M44 ${f(-14 + bob)} L56 ${f(-9 + bob)} L44 ${f(-2 + bob)} Z" fill="${P.light}"/>
${twoTone(`<path d="M4 ${f(-12 + bob)} H22 V${f(8 + bob)} Q13 ${f(20 + bob)} 4 ${f(8 + bob)} Z"/>`, P.body, P.deep)}
<path d="M13 ${f(-10 + bob)} V${f(12 + bob)} M6 ${f(-2 + bob)} H20" stroke="${P.light}" stroke-width="2.4"/>`;
}

// ───────────────────────── боссы ─────────────────────────

/** Вещун — кастер. Глаз: капюшон, вместо лица — одно огромное око, вокруг — руны. */
function seer(t, P) {
  const w = Math.sin(t * TAU);
  const bob = w * 3;
  const robe = `<path d="M-14 ${f(-20 + bob)} Q-30 ${f(10 + bob)} -34 ${f(38 + bob)} L${f(-24 + w * 3)} ${f(32 + bob)} L${f(-14 - w * 2)} ${f(40 + bob)} L${f(-4 + w * 3)} ${f(32 + bob)} L${f(6 - w * 2)} ${f(40 + bob)} L${f(16 + w * 3)} ${f(32 + bob)} L${f(26 - w * 2)} ${f(40 + bob)} Q30 ${f(10 + bob)} 14 ${f(-20 + bob)} Z"/>`;
  const rune = (k) => {
    const a = (t + k / 3) * TAU;
    const x = Math.cos(a) * 40;
    const y = Math.sin(a) * 12 - 4 + bob;
    return `<path d="M${f(x)} ${f(y - 6)} L${f(x + 4)} ${f(y)} L${f(x)} ${f(y + 6)} L${f(x - 4)} ${f(y)} Z" fill="${P.eye}" opacity="${f(0.55 + 0.45 * Math.sin(a))}"/>`;
  };
  return `
${rune(0)}
${twoTone(robe, P.body, P.shade, -3, -2)}
<path d="M-10 ${f(-2 + bob)} Q0 ${f(30 + bob)} 10 ${f(-2 + bob)}" fill="none" stroke="${P.light}" stroke-width="2.5" opacity="0.7"/>
${twoTone(`<path d="M-24 ${f(-8 + bob)} Q-26 ${f(-48 + bob)} 0 ${f(-48 + bob)} Q26 ${f(-48 + bob)} 24 ${f(-8 + bob)} Q0 ${f(-2 + bob)} -24 ${f(-8 + bob)} Z"/>`, P.body, P.shade)}
<ellipse cx="0" cy="${f(-24 + bob)}" rx="16" ry="14" fill="${P.pupil}"/>
<ellipse cx="0" cy="${f(-24 + bob)}" rx="13" ry="${f(9 + w * 1.5)}" fill="${P.eye}"/>
<circle cx="${f(2 + w * 3)}" cy="${f(-24 + bob)}" r="6" fill="${P.pupil}"/><circle cx="${f(4 + w * 3)}" cy="${f(-26 + bob)}" r="2" fill="#fff"/>
<path d="M-26 ${f(-6 + bob)} Q-40 ${f(-14 + w * 4)} -42 ${f(-30 + w * 4)} M26 ${f(-6 + bob)} Q40 ${f(-14 - w * 4)} 42 ${f(-30 - w * 4)}" fill="none" stroke="${P.shade}" stroke-width="5" stroke-linecap="round"/>
<circle cx="-42" cy="${f(-32 + w * 4)}" r="4" fill="${P.eye}" opacity="0.8"/><circle cx="42" cy="${f(-32 - w * 4)}" r="4" fill="${P.eye}" opacity="0.8"/>
${rune(1)}${rune(2)}`;
}

/** Матрёшка — делящийся босс. Две фигуры в одной: шов посередине светится, она вот-вот раскроется. */
function matryoshka(t, P) {
  const w = Math.sin(t * TAU);
  const tilt = w * 6;
  const doll = `<path d="M0 -46 Q20 -46 21 -26 Q34 -14 34 10 Q34 40 0 42 Q-34 40 -34 10 Q-34 -14 -21 -26 Q-20 -46 0 -46 Z"/>`;
  return `
<g transform="rotate(${f(tilt)} 0 42)">
${twoTone(doll, P.body, P.shade, -3, -3)}
<path d="M-18 -30 Q0 -40 18 -30 Q20 -8 0 -6 Q-20 -8 -18 -30 Z" fill="#f6dcc4"/>
<path d="M-18 -30 Q0 -40 18 -30" fill="none" stroke="${P.light}" stroke-width="3"/>
<path d="M-12 -25 L-3 -21 L-11 -19 Z M12 -25 L3 -21 L11 -19 Z" fill="${P.pupil}"/>
<circle cx="-8" cy="-21.5" r="1.3" fill="${P.eye}"/><circle cx="8" cy="-21.5" r="1.3" fill="${P.eye}"/>
<circle cx="-12" cy="-15" r="3" fill="${P.body}" opacity="0.55"/><circle cx="12" cy="-15" r="3" fill="${P.body}" opacity="0.55"/>
<path d="M-9 -14 Q0 -6 9 -14 Q0 -10 -9 -14 Z" fill="${P.pupil}"/><path d="M-6 -12.5 l1.5 2 l1.5 -2 l1.5 2 l1.5 -2 l1.5 2 l1.5 -2" fill="none" stroke="#f6dcc4" stroke-width="1"/>
<path d="M-34 4 L-26 0 L-18 6 L-10 -1 L-2 6 L6 -1 L14 6 L22 0 L34 4" fill="none" stroke="${P.eye}" stroke-width="2.6" opacity="${f(0.75 + 0.25 * w)}"/>
<ellipse cx="0" cy="22" rx="18" ry="13" fill="${P.light}" opacity="0.9"/>
<circle cx="0" cy="22" r="6" fill="${P.body}"/><circle cx="-10" cy="18" r="4" fill="${P.shade}"/><circle cx="10" cy="18" r="4" fill="${P.shade}"/><circle cx="0" cy="31" r="3.5" fill="${P.shade}"/>
<path d="M-26 -10 Q-30 10 -24 30" fill="none" stroke="${P.light}" stroke-width="3" stroke-linecap="round" opacity="0.6"/>
</g>`;
}

// ───────────────────── запланированные (direction-v2.md §5.1) ─────────────────────

/**
 * Страж рубежа (T-0120) — Чур: в славянской мифологии хранитель границ.
 * Резной деревянный идол-воин с копьём, летит над землёй и проносится насквозь
 * (паттерн rush). Глаза-угли, на груди — знак-оберег.
 */
function rubezhGuard(t, P) {
  const w = Math.sin(t * TAU);
  const hover = w * 2.5;
  const lean = 8;
  const trail = [0, 1, 2]
    .map((k) => `<path d="M${f(-26 - k * 9)} ${f(-6 + k * 8 + hover)} H${f(-12 - k * 9)}" stroke="${P.light}" stroke-width="${f(3 - k * 0.8)}" stroke-linecap="round" opacity="${f(0.5 - k * 0.14)}"/>`)
    .join("");
  const pillar = `<path d="M-14 ${f(34 + hover)} L-16 ${f(-18 + hover)} Q-16 ${f(-30 + hover)} -8 ${f(-36 + hover)} L8 ${f(-36 + hover)} Q16 ${f(-30 + hover)} 16 ${f(-18 + hover)} L14 ${f(34 + hover)} Z"/>`;
  return `<g transform="rotate(${f(lean)} 0 10)">
${trail}
${twoTone(pillar, P.body, P.shade, -3, -2)}
<path d="M-15 ${f(-6 + hover)} H15 M-14 ${f(12 + hover)} H14 M-13 ${f(26 + hover)} H13" stroke="${P.deep}" stroke-width="2.4"/>
${twoTone(`<path d="M-12 ${f(-36 + hover)} L0 ${f(-52 + hover)} L12 ${f(-36 + hover)} Z"/>`, P.light, P.body)}
<path d="M-10 ${f(-24 + hover)} H10" stroke="${P.pupil}" stroke-width="5" stroke-linecap="round"/>
${glowEye(-5, -24 + hover, 2.1, P)}${glowEye(5, -24 + hover, 2.1, P)}
<path d="M0 ${f(-2 + hover)} L6 ${f(4 + hover)} L0 ${f(10 + hover)} L-6 ${f(4 + hover)} Z" fill="${P.eye}" opacity="0.85"/>
<path d="M0 ${f(1 + hover)} L3 ${f(4 + hover)} L0 ${f(7 + hover)} L-3 ${f(4 + hover)} Z" fill="${P.deep}"/>
<path d="M12 ${f(-10 + hover)} L46 ${f(-30 + hover)}" stroke="${P.bone}" stroke-width="3.6" stroke-linecap="round"/>
<path d="M42 ${f(-36 + hover)} L52 ${f(-34 + hover)} L46 ${f(-26 + hover)} Z" fill="${P.light}"/>
<ellipse cx="0" cy="${f(40 + hover * 0.4)}" rx="12" ry="3" fill="${P.eye}" opacity="0.22"/>
</g>`;
}

/**
 * Страж кольца (T-0171) — щитоносец строя. Большой круглый щит развёрнут к
 * игроку: двадцать стражей в кольце читаются стеной щитов, а не толпой.
 */
function cordonGuard(t, P) {
  const w = Math.sin(t * TAU);
  const bob = -Math.abs(w) * 1.5;
  return `
${leg(-8, 16 + bob, w * 0.35, 22, 7, P.deep)}${leg(4, 16 + bob, -w * 0.35, 22, 7, P.shade)}
${twoTone(`<path d="M-18 ${f(20 + bob)} L-20 ${f(-10 + bob)} Q-4 ${f(-20 + bob)} 12 ${f(-10 + bob)} L10 ${f(20 + bob)} Z"/>`, P.body, P.shade)}
${twoTone(`<path d="M-12 ${f(-14 + bob)} Q-12 ${f(-36 + bob)} 0 ${f(-36 + bob)} Q12 ${f(-36 + bob)} 12 ${f(-14 + bob)} Z"/>`, P.light, P.body)}
<path d="M-6 ${f(-24 + bob)} H12" stroke="${P.pupil}" stroke-width="3.5"/>${glowEye(6, -24 + bob, 1.7, P)}
<path d="M0 ${f(-36 + bob)} V${f(-44 + bob)}" stroke="${P.light}" stroke-width="3" stroke-linecap="round"/>
<path d="M-16 ${f(-6 + bob)} L-24 ${f(-46 + bob)}" stroke="${P.bone}" stroke-width="3.4" stroke-linecap="round"/>
<path d="M-28 ${f(-52 + bob)} L-24 ${f(-42 + bob)} L-20 ${f(-52 + bob)} Z" fill="${P.light}"/>
${twoTone(`<circle cx="14" cy="${f(2 + bob)}" r="22"/>`, P.deep, P.pupil, -2, -2)}
<circle cx="14" cy="${f(2 + bob)}" r="22" fill="none" stroke="${P.bone}" stroke-width="3"/>
<circle cx="14" cy="${f(2 + bob)}" r="14" fill="none" stroke="${P.shade}" stroke-width="2"/>
<path d="M14 ${f(-12 + bob)} L22 ${f(2 + bob)} L14 ${f(16 + bob)} L6 ${f(2 + bob)} Z" fill="${P.eye}" opacity="0.75"/>
<circle cx="14" cy="${f(2 + bob)}" r="4" fill="${P.bone}"/>`;
}

/**
 * Таран (T-0197) — огромный зверь-баран, паттерн dash: подходит, мигает и
 * рвётся по прямой рогами вперёд. Силуэт — остриё, как у волка, но
 * тяжёлое: рога и загривок.
 */
function ram(t, P) {
  const a = Math.sin(t * TAU);
  const bob = -Math.abs(Math.cos(t * TAU)) * 2;
  const legs =
    leg(-22, 10 + bob, -a * 0.5, 24, 8, P.deep) +
    leg(-12, 10 + bob, -a * 0.5 + 0.3, 24, 8, P.shade) +
    leg(10, 10 + bob, a * 0.5, 24, 8, P.deep) +
    leg(20, 10 + bob, a * 0.5 - 0.3, 24, 8, P.shade);
  const body = `<path d="M-38 ${f(6 + bob)} Q-40 ${f(-22 + bob)} -14 ${f(-28 + bob)} Q8 ${f(-34 + bob)} 22 ${f(-24 + bob)} L30 ${f(-8 + bob)} Q30 ${f(14 + bob)} 6 ${f(16 + bob)} Q-24 ${f(20 + bob)} -38 ${f(6 + bob)} Z"/>`;
  const wool = [-30, -20, -10, 0, 10]
    .map((x, k) => `<circle cx="${f(x)}" cy="${f(-24 + (k % 2) * 4 + bob)}" r="7" fill="${P.light}" opacity="0.55"/>`)
    .join("");
  return `
${legs}
${twoTone(body, P.body, P.shade, -3, -3)}
${wool}
${twoTone(`<path d="M18 ${f(-22 + bob)} Q40 ${f(-24 + bob)} 46 ${f(-6 + bob)} Q44 ${f(8 + bob)} 30 ${f(8 + bob)} Q18 ${f(4 + bob)} 18 ${f(-22 + bob)} Z"/>`, P.body, P.deep)}
<path d="M24 ${f(-20 + bob)} Q8 ${f(-40 + bob)} 26 ${f(-46 + bob)} Q44 ${f(-48 + bob)} 44 ${f(-30 + bob)} Q40 ${f(-20 + bob)} 32 ${f(-26 + bob)}" fill="none" stroke="${P.bone}" stroke-width="7" stroke-linecap="round"/>
<path d="M30 ${f(-34 + bob)} Q36 ${f(-38 + bob)} 38 ${f(-30 + bob)}" fill="none" stroke="${P.shade}" stroke-width="2"/>
${glowEye(36, -10 + bob, 2.4, P)}
<path d="M42 ${f(2 + bob)} L50 ${f(0 + bob)}" stroke="${P.pupil}" stroke-width="2" stroke-linecap="round"/>`;
}

// ───────────────────────── каталог ─────────────────────────

/**
 * Каталог по id врага из `content/enemies.ts`. Облик — по врагу, а не по
 * паттерну: костяной ходок и упырь делят паттерн «chase», но не тело.
 * `pattern` и `rank` — для цвета; `radius` — хитбокс в игровых единицах
 * (PATTERN_TRAITS × множитель ранга), по нему считается размер ячейки.
 * `pad` — запас ячейки для рисунка, который выходит за неё: копьё Чура, меч
 * рыцаря, рог Барана. Без него край кадра срезал их, и на `size` 2 копьё
 * кончалось плоским срезом в кайме. Число — замер `src/frame-fit.mjs`.
 */
export const ENEMY_ART = [
  { id: "swarm_rat", pattern: "swarm", radius: 7, draw: rat },
  { id: "mire_shambler", pattern: "swarm", radius: 7, draw: shambler },
  { id: "tank_ghoul", pattern: "chase", radius: 12, draw: ghoul },
  { id: "bone_walker", pattern: "chase", radius: 12, draw: boneWalker },
  { id: "shooter_wisp", pattern: "kite_and_shoot", radius: 9, draw: wisp, pad: 1.01 },
  { id: "dasher_wolf", pattern: "dash", radius: 10, draw: wolf, pad: 1.01 },
  { id: "circler_crow", pattern: "orbit", radius: 8, draw: crow, pad: 1.13 },
  { id: "bomber_imp", pattern: "exploder", radius: 9, draw: imp, pad: 1.04 },
  { id: "splitter_slime", pattern: "splitter", radius: 13, draw: slime },
  { id: "rushing_bats", pattern: "rush", radius: 6, draw: bats },
  { id: "elite_ghoul", pattern: "chase", rank: "elite", radius: 12 * 1.7, draw: eliteGhoul, pad: 1.02 },
  { id: "elite_grave_knight", pattern: "dash", rank: "elite", radius: 10 * 1.7, draw: graveKnight, pad: 1.2 },
  { id: "boss_seer", pattern: "caster", rank: "boss", radius: 14 * 2.4, draw: seer, pad: 1.07 },
  { id: "boss_matryoshka", pattern: "splitter", rank: "boss", radius: 13 * 2.4, draw: matryoshka },
  // Запланированные (direction-v2.md §5.1): облик готов раньше контента.
  { id: "rubezh_guard", pattern: "rush", rank: "boss", radius: 6 * 2.4, draw: rubezhGuard, pad: 1.26, planned: "T-0120" },
  { id: "cordon_guard", pattern: "chase", radius: 14, draw: cordonGuard, pad: 1.11, planned: "T-0171" },
  { id: "boss_ram", pattern: "dash", rank: "boss", radius: 10 * 2.4, draw: ram, pad: 1.1, planned: "T-0197" },
];
