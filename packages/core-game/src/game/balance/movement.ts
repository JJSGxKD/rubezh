import type { World } from "../sim/world";

/**
 * Мера движения бота калибровки (Р223, T-0472): доля тиков, когда игрок стоит на месте. Ею мерится,
 * сдвинул ли Карачун стоящего бота: медиана выживания эту цель не показывает (бот, ушедший с места,
 * не попадает в осаду и живёт не короче, `docs/32-balance.md` §2.11).
 *
 * Сбор читает мир после шага и ничего в нём не меняет, поэтому забег с мерой побитово равен забегу без неё.
 */

/**
 * Порог движения — доля номинальной скорости бега (`config.player.speedPxSec`): ниже неё игрок «на
 * месте». Десятая часть: разгон до неё занимает сотую долю секунды, а шаг стоящего бота
 * (`STAND_STEP`, 24 тика на полной скорости) проходит порог целиком; остаточная скорость торможения
 * на меру не влияет.
 */
export const STILL_SPEED_SHARE = 0.1;

/**
 * С какой секунды забега считается мера: с отметки, с которой может прийти Карачун
 * (`STALKER.appear.fromSec`, тест сверяет). Раньше он на бота не влияет, а до `STAND_FROM_SEC` стоящий бот
 * бегает, как все, — выборка с начала забега разбавила бы меру тем, что Карачун изменить не может.
 * Окно не зависит от контента прогона: у «без Карачуна» отметка вынесена за забег, а окно то же.
 */
export const MOVEMENT_FROM_SEC = 240;

export interface MovementTally {
  /** тиков, на которых скорость игрока ниже порога движения */
  still: number;
  /** всех учтённых тиков */
  total: number;
}

export function createMovementTally(): MovementTally {
  return { still: 0, total: 0 };
}

/** Учитывает один тик — после шага мира; окно `MOVEMENT_FROM_SEC` держит вызывающий. Сравнение квадратов: корень не нужен. */
export function recordMovement(tally: MovementTally, world: World): void {
  const threshold = world.config.player.speedPxSec * STILL_SPEED_SHARE;
  const { vx, vy } = world.player;
  tally.total++;
  if (vx * vx + vy * vy < threshold * threshold) tally.still++;
}

/** Доля тиков на месте; пустая выборка — 0, а не NaN. */
export function stillShareOf(tally: MovementTally): number {
  return tally.total === 0 ? 0 : tally.still / tally.total;
}
