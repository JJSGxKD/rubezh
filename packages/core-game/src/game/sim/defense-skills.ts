import { TICK_HZ, type World } from "./world";

/**
 * Навыки защиты через игру (Р157, tasks/T-0286): «Вампиризм» лечит за убийство,
 * «Стойкость» раз в N секунд сама ставит щит на одно попадание.
 *
 * Всё считается в тиках и не трогает `world.rng`: навыки не двигают ни
 * раскладку, ни предложения уровней, а повтор забега попадает в тот же тик.
 * Отдельным файлом, чтобы `combat.ts` и `step.ts` звали одну точку, а не
 * дублировали правила потолка.
 */

/** Потолок лечения от убийств: доля максимума здоровья за окно. */
export const VAMPIRISM_CAP_RATIO = 0.04;
/**
 * Окно потолка — секунда: толпа из сотни крыс не делает игрока бессмертным. В
 * секундах, а не в тиках: `TICK_HZ` из `world.ts` на верхнем уровне модуля
 * недоступен — модули зовут друг друга по кругу.
 */
export const VAMPIRISM_WINDOW_SEC = 1;

/**
 * Лечение за убийство. Потолок считается окном, которое открывает первое
 * вылеченное убийство: лечение, не потратившее потолок (здоровье полное),
 * окна не занимает. Вылеченное считается по факту — упёршееся в максимум
 * здоровья потолка не съедает.
 */
export function healOnKill(world: World): void {
  const amount = world.playerStats.healOnKill;
  const player = world.player;
  if (amount <= 0 || !player.alive) return;

  const room = world.playerStats.maxHp - player.hp;
  if (room <= 0) return;

  const tick = world.stats.tick;
  if (player.healedInWindow <= 0 || tick - player.healWindowStart >= VAMPIRISM_WINDOW_SEC * TICK_HZ) {
    player.healWindowStart = tick;
    player.healedInWindow = 0;
  }
  const left = world.playerStats.maxHp * VAMPIRISM_CAP_RATIO - player.healedInWindow;
  const healed = Math.min(amount, room, left);
  if (healed <= 0) return;

  player.hp += healed;
  player.healedInWindow += healed;
}

/** Период щита в тиках; 0 — «Стойкости» нет. */
function wardIntervalTicks(world: World): number {
  const sec = world.playerStats.wardIntervalSec;
  return sec > 0 ? Math.round(sec * TICK_HZ) : 0;
}

/**
 * Таймер «Стойкости»: идёт, пока собственного щита оберега нет, и по истечении
 * добавляет один щит к `shieldHits` — щиты буста «Эгида» лежат сверху и от
 * оберега не зависят. Таймер не копится, пока навыка нет.
 */
export function tickWard(world: World): void {
  const player = world.player;
  const interval = wardIntervalTicks(world);
  if (interval === 0 || !player.alive || player.wardShield > 0) return;

  player.wardTicks++;
  if (player.wardTicks < interval) return;
  player.wardTicks = 0;
  player.wardShield = 1;
  player.shieldHits++;
}
