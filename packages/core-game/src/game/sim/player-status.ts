import { ELEMENT_COLD, ELEMENT_FIRE, ELEMENT_LIGHTNING, ELEMENT_PHYSICAL, ELEMENT_POISON } from "./element-ids";
import type { PlayerState, World } from "./world";

/**
 * Состояния на игроке (docs/35-stage4-plan.md, §3.3, WP6): их накладывают
 * стихийные атаки врагов — касание, взрыв, снаряд.
 *
 * Те же четыре стихии, что на врагах, но мягче и **без заморозки**: замёрзший
 * в толпе игрок гибнет, не успев ничего сделать, а смерть без решения —
 * худшее, что может дать забег. Холод на игроке только замедляет — и этим
 * уже опасен: «замедление в толпе — смерть», отсюда цена сопротивления холоду.
 *
 * **Сопротивление** игрока гасит и урон стихии, и длительность её состояния:
 * иначе сопротивление холоду и шоку, у которых урона нет, ничего бы не давало.
 * Потолок — `MAX_PLAYER_RESIST`: полная неуязвимость к стихии отменила бы
 * угрозу целого врага.
 *
 * Урон по времени идёт мимо брони: броня вычитается из попадания, а тик
 * горения — это сотые доли единицы, и броня съедала бы его целиком.
 *
 * **Числа — рабочие** (Р31).
 */

/** Горение: доля урона попадания в секунду и сколько горит. */
export const PLAYER_BURN_DPS_SHARE = 0.2;
export const PLAYER_BURN_SEC = 2;
/** Холод: насколько медленнее бежит игрок и сколько держится. */
export const PLAYER_CHILL_SLOW = 0.3;
export const PLAYER_CHILL_SEC = 1.5;
/** Шок: насколько больше урона получает шокированный игрок. */
export const PLAYER_SHOCK_BONUS = 0.2;
export const PLAYER_SHOCK_SEC = 3;
/** Яд: доля урона попадания в секунду за слой, потолок слоёв и длительность. */
export const PLAYER_POISON_DPS_SHARE = 0.05;
export const PLAYER_POISON_MAX_STACKS = 5;
export const PLAYER_POISON_SEC = 4;
/** Потолок сопротивления игрока любой стихии. */
export const MAX_PLAYER_RESIST = 0.75;

/** Сопротивление игрока стихии с потолком; у физического его нет. */
export function playerResist(world: World, element: number): number {
  const stats = world.playerStats;
  let resist = 0;
  switch (element) {
    case ELEMENT_FIRE:
      resist = stats.resistFire;
      break;
    case ELEMENT_COLD:
      resist = stats.resistCold;
      break;
    case ELEMENT_LIGHTNING:
      resist = stats.resistLightning;
      break;
    case ELEMENT_POISON:
      resist = stats.resistPoison;
      break;
  }
  return Math.min(MAX_PLAYER_RESIST, Math.max(0, resist));
}

/** Множитель входящего урона от состояний: шокированный получает больше. */
export function playerDamageTakenMul(player: PlayerState): number {
  return player.shockTimer > 0 ? 1 + PLAYER_SHOCK_BONUS : 1;
}

/** Во сколько раз медленнее бежит игрок: охлаждённый — медленнее. */
export function playerSlowFactor(player: PlayerState): number {
  return player.chillTimer > 0 ? 1 - PLAYER_CHILL_SLOW : 1;
}

/**
 * Наложить состояние после попадания стихийной атакой. `dealt` — урон этого
 * попадания уже с сопротивлением и бронёй: горение и яд считаются от него.
 * `source` — тип врага: умерший от горения погиб от того, кто поджёг.
 */
export function applyPlayerStatus(world: World, element: number, chance: number, dealt: number, source: number): void {
  if (element === ELEMENT_PHYSICAL || chance <= 0) return;
  if (chance < 1 && world.rng.nextFloat() >= chance) return;
  const player = world.player;
  const keep = 1 - playerResist(world, element);
  switch (element) {
    case ELEMENT_FIRE: {
      player.burnTimer = Math.max(player.burnTimer, PLAYER_BURN_SEC * keep);
      player.burnDps = Math.max(player.burnDps, dealt * PLAYER_BURN_DPS_SHARE);
      player.burnSource = source;
      return;
    }
    case ELEMENT_COLD: {
      player.chillTimer = Math.max(player.chillTimer, PLAYER_CHILL_SEC * keep);
      return;
    }
    case ELEMENT_LIGHTNING: {
      player.shockTimer = Math.max(player.shockTimer, PLAYER_SHOCK_SEC * keep);
      return;
    }
    case ELEMENT_POISON: {
      player.poisonStacks = Math.min(PLAYER_POISON_MAX_STACKS, player.poisonStacks + 1);
      player.poisonTimer = PLAYER_POISON_SEC * keep;
      player.poisonDps = Math.max(player.poisonDps, dealt * PLAYER_POISON_DPS_SHARE);
      player.poisonSource = source;
      return;
    }
  }
}

/**
 * Тик состояний игрока: таймеры убывают, урон по времени снимается сразу.
 * Неуязвимость после второго шанса глушит и его — иначе игрок, вернувшийся
 * с горением, погиб бы в первую же секунду «защиты».
 */
export function tickPlayerStatuses(world: World, dt: number): void {
  const player = world.player;
  if (!player.alive) return;

  let burn = 0;
  let poison = 0;
  if (player.burnTimer > 0) {
    burn = player.burnDps * Math.min(dt, player.burnTimer);
    player.burnTimer -= dt;
    if (player.burnTimer <= 0) {
      player.burnTimer = 0;
      player.burnDps = 0;
    }
  }
  if (player.poisonTimer > 0) {
    poison = player.poisonDps * player.poisonStacks * Math.min(dt, player.poisonTimer);
    player.poisonTimer -= dt;
    if (player.poisonTimer <= 0) {
      player.poisonTimer = 0;
      player.poisonStacks = 0;
      player.poisonDps = 0;
    }
  }
  if (player.chillTimer > 0) player.chillTimer = Math.max(0, player.chillTimer - dt);
  if (player.shockTimer > 0) player.shockTimer = Math.max(0, player.shockTimer - dt);

  if (burn > 0) inflictPlayerDot(world, burn, player.burnSource);
  if (poison > 0 && player.alive) inflictPlayerDot(world, poison, player.poisonSource);
}

function inflictPlayerDot(world: World, amount: number, source: number): void {
  const player = world.player;
  if (player.invulnerableTicks > 0 || world.cheats.godMode) return;
  player.hp -= amount;
  world.stats.damageTaken += amount;
  if (player.hp <= 0) {
    player.hp = 0;
    player.alive = false;
    world.stats.deathCauseType = source;
  }
}

/** Снять все состояния: второй шанс возвращает игрока чистым. */
export function clearPlayerStatuses(player: PlayerState): void {
  player.burnTimer = 0;
  player.burnDps = 0;
  player.burnSource = -1;
  player.chillTimer = 0;
  player.shockTimer = 0;
  player.poisonTimer = 0;
  player.poisonStacks = 0;
  player.poisonDps = 0;
  player.poisonSource = -1;
}
