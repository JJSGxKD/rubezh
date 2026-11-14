import type { World } from "./world";

/**
 * Скрытые враги: живые, но не на поле (`patterns/blink.ts`, Р157). Кикимора, исчезнув, не цель
 * оружия, не попадает в сетку запросов и не бьёт касанием, при этом остаётся в пуле: она
 * занимает слот и входит в потолок живых, а через долю секунды появляется в точке метки.
 *
 * Маска живёт в мире, а не в пуле врагов: пул кодируется в снимок поле за полем, и новый массив
 * сломал бы чтение прежних снимков. Истина — фаза врага и признак его паттерна
 * (`EnemyType.hiddenPhase`); маска выводится из них (`rebuildHiddenMask`) при восстановлении
 * снимка, а в забеге её ведёт сам паттерн.
 */
export interface HiddenState {
  /** 1 — слот скрыт: оружие, сетка, подборы и радар его не видят */
  mask: Uint8Array;
  /**
   * Маска изменилась после того, как сетка перестроена: шаг перестраивает сетку заново, иначе
   * только что исчезнувший враг оставался бы целью до конца тика, а появившийся — не целью.
   */
  dirty: boolean;
}

export function createHiddenState(maxEnemies: number): HiddenState {
  return { mask: new Uint8Array(maxEnemies), dirty: false };
}

/** Спрятать или показать врага слота; маска меняется только при смене признака. */
export function setHidden(world: World, index: number, hidden: boolean): void {
  const next = hidden ? 1 : 0;
  if (world.hidden.mask[index] === next) return;
  world.hidden.mask[index] = next;
  world.hidden.dirty = true;
}

/** Скрыт ли враг слота. */
export function isHidden(world: World, index: number): boolean {
  return world.hidden.mask[index] === 1;
}

/**
 * Пересчитать маску по фазам врагов: после восстановления снимка, где маски нет. Скрытым считается
 * живой враг, чей тип прячется именно в той фазе, в которой он сейчас.
 */
export function rebuildHiddenMask(world: World): void {
  const enemies = world.enemies;
  const mask = world.hidden.mask;
  mask.fill(0);
  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 0) continue;
    const hiddenPhase = world.enemyTypes[enemies.type[i]].hiddenPhase;
    if (hiddenPhase >= 0 && enemies.phase[i] === hiddenPhase) mask[i] = 1;
  }
  world.hidden.dirty = false;
}
