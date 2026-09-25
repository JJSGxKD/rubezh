import type { EnemyPool } from "../sim/pools";

/**
 * Тон состояния врага на канве (docs/35-stage4-plan.md, WP6): без него стихия
 * в контенте работает вслепую — игрок не видит, что враг горит, замёрз или
 * шокирован и по нему сейчас перескочит молния.
 *
 * Из нескольких состояний виден одно — то, от которого больше зависит бой:
 * заморозка (враг не ходит и не бьёт), шок (по нему перескакивает молния),
 * горение, яд, холод. Порядок — индекс в `STATUS_TONE_COLORS`.
 */
export const STATUS_TONE = {
  none: 0,
  frozen: 1,
  shock: 2,
  burn: 3,
  poison: 4,
  chill: 5,
} as const;

/** Цвет заливки по тону. Заморозка — светлее холода: это его предел, а не другая стихия. */
export const STATUS_TONE_COLORS: readonly number[] = [0, 0xb8ecff, 0xfff06a, 0xff7a2e, 0x8ee05a, 0x4f9dff];

/**
 * Пульс тона: `STATUS_PULSE_ON` тиков заливки из каждых `STATUS_PULSE_TICKS`.
 * Остальное время враг выглядит собой — цвет тела говорит о ступени, и
 * постоянная заливка стёрла бы его на всю толпу, по которой прошёлся «Очаг».
 */
export const STATUS_PULSE_TICKS = 30;
export const STATUS_PULSE_ON = 10;

/**
 * Сдвиг пульса по слоту пула: толпа мерцает вразнобой, а не вспыхивает разом
 * стробоскопом. Простое число — соседние слоты не попадают в одну фазу.
 */
const PULSE_SLOT_SHIFT = 7;

/**
 * Тон врага в этот тик. Заморозка горит постоянно: она длится секунду, и
 * игрок должен увидеть её сразу, а не на следующем такте пульса.
 */
export function statusTone(enemies: EnemyPool, index: number, tick: number): number {
  if (enemies.frozenTimer[index] > 0) return STATUS_TONE.frozen;
  if ((tick + index * PULSE_SLOT_SHIFT) % STATUS_PULSE_TICKS >= STATUS_PULSE_ON) return STATUS_TONE.none;
  if (enemies.shockTimer[index] > 0) return STATUS_TONE.shock;
  if (enemies.burnTimer[index] > 0) return STATUS_TONE.burn;
  if (enemies.poisonTimer[index] > 0) return STATUS_TONE.poison;
  if (enemies.chillTimer[index] > 0) return STATUS_TONE.chill;
  return STATUS_TONE.none;
}
