/**
 * Неуязвимость после второго шанса видна на персонаже: иначе непонятно, почему
 * враги не ранят и когда начнут. Это чтение боя, а не украшение, поэтому
 * выключателя в настройках у пульса нет (docs/27-design-system-and-app-shell.md
 * §7.1). Пульс мягкий — прозрачность, а не вспышка — и не чаще трёх раз в
 * секунду: чаще — уже раздражитель для светочувствительных игроков.
 */
const INVULNERABLE_PULSE_TICKS = 20;
const INVULNERABLE_MIN_ALPHA = 0.4;

export function invulnerableAlpha(invulnerableTicks: number): number {
  if (invulnerableTicks <= 0) return 1;
  const phase = (invulnerableTicks % INVULNERABLE_PULSE_TICKS) / INVULNERABLE_PULSE_TICKS;
  // Треугольная волна: без тригонометрии и с тем же видом на любом устройстве.
  const wave = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  return INVULNERABLE_MIN_ALPHA + (1 - INVULNERABLE_MIN_ALPHA) * wave;
}
