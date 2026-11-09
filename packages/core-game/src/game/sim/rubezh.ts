import type { EnemyRank, RubezhDef, RunRubezh } from "@bh/shared-types";
import { createDirection, randomDirection } from "./directions";
import type { Rng } from "./rng";
import { spawnOnRing } from "./spawner";
import { TICK_HZ, type World } from "./world";

/**
 * Рубеж: цель забега (docs/39-retention-mechanics.md Б6, Р102, Р105). На
 * отметке `RUBEZH_AT_SEC` приходит страж; убитый страж — победа, дальше забег
 * идёт как прежде. Победа не отдельный исход, а поле итога (`RunResult.rubezh`).
 *
 * Фазы идут в одну сторону: `pending → guard → cleared`; `skipped` — стража в
 * этом забеге не будет (правил рубежа в мире нет, стража нет в контенте, или
 * забег начат до этой механики и отметка уже позади).
 *
 * Случайность — собственный поток `world.rubezh.rng`, а не `world.rng`: иначе
 * приход стража сдвинул бы все golden-прогоны и предложения уровней. Ни одного
 * обращения к основному потоку в этом файле быть не должно, и тест это проверяет.
 */
export type RubezhPhase = "pending" | "guard" | "cleared" | "skipped";

export const RUBEZH_PHASES: readonly RubezhPhase[] = ["pending", "guard", "cleared", "skipped"];

export interface RubezhState {
  /** собственный поток случайности: место стража берётся из него */
  rng: Rng;
  phase: RubezhPhase;
  /** секунда забега, на которой страж пал; `null` — не пал */
  clearedSec: number | null;
  /** индекс типа стража в `enemyTypes`; −1 — стража в мире нет */
  guardType: number;
  /** тик, с которого страж приходит; выводится из правил, в снимок не входит */
  atTick: number;
}

/** Тип врага в мире: нужен только ранг, чтобы не тянуть сюда весь `EnemyType`. */
interface TypeLike {
  id: string;
  rank: EnemyRank | "normal";
}

/**
 * Состояние рубежа нового мира. Нет правил или нет стража в списке врагов —
 * `skipped`: песочница редактора баланса и стенды без рубежа не ломаются.
 */
export function createRubezhState(rng: Rng, rules: RubezhDef | null, types: readonly TypeLike[]): RubezhState {
  const guardType = rules === null ? -1 : types.findIndex((type) => type.id === rules.guard);
  return {
    rng,
    phase: guardType < 0 ? "skipped" : "pending",
    clearedSec: null,
    guardType,
    atTick: rules === null ? 0 : Math.round(rules.atSec * TICK_HZ),
  };
}

const direction = createDirection();

/**
 * Ближе этого числа секунд к отметке боссов таймлайна нет: страж приходит один
 * (Р126). Событие босса из окна не пропадает, а переносится на первый отрезок
 * после него (`sim/timeline.ts`).
 */
export const BOSS_CLEARANCE_SEC = 60;

/** Окно вокруг отметки, в котором событий боссов нет; в мире без стража окна нет. */
export function isInBossClearance(world: World, sec: number): boolean {
  const state = world.rubezh;
  if (state.guardType < 0) return false;
  return Math.abs(sec - state.atTick / TICK_HZ) < BOSS_CLEARANCE_SEC;
}

/**
 * Шаг рубежа: на отметке ставит стража. Вызывается из `stepWorld` каждый тик и
 * в обычное время только сравнивает фазу.
 *
 * Страж приходит кольцом спавна, как событие `ring` таймлайна, но потолок живых
 * не проверяет: он главное событие забега, и толпа не вправе его отменить.
 * Упирается только пул слотов — если места нет вовсе, попытка повторяется на
 * следующем тике.
 */
export function stepRubezh(world: World): void {
  const state = world.rubezh;
  if (state.phase !== "pending" || world.stats.tick < state.atTick) return;

  randomDirection(state.rng, direction);
  if (spawnOnRing(world, state.guardType, direction.x, direction.y, state.rng) < 0) return;
  state.phase = "guard";
}

/**
 * Смерть врага: если пал страж при фазе `guard` — рубеж взят. Зовётся из
 * `killEnemy` на любую смерть и по индексу типа отсекает всех прочих.
 */
export function onRubezhEnemyKilled(world: World, typeIndex: number): void {
  const state = world.rubezh;
  if (typeIndex !== state.guardType || state.phase !== "guard") return;
  state.phase = "cleared";
  state.clearedSec = world.stats.elapsedSec;
}

/** Пока страж жив, боссы таймлайна пропускаются: два босса сразу — не цель рубежа. */
export function isGuardAlive(world: World): boolean {
  return world.rubezh.phase === "guard";
}

/** Живой страж: индекс слота или −1. Индексы врагов переиспользуются, поэтому ищем по типу. */
function findLiveGuard(world: World): number {
  const enemies = world.enemies;
  const guardType = world.rubezh.guardType;
  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 1 && enemies.type[i] === guardType) return i;
  }
  return -1;
}

/** Рубеж для итога забега: «почти победил» для экрана смерти. */
export function describeRubezh(world: World): RunRubezh {
  const state = world.rubezh;
  let guardHpPercent: number | null = null;

  if (state.phase === "guard") {
    const guard = findLiveGuard(world);
    if (guard >= 0 && world.enemies.maxHp[guard] > 0) {
      // Живой страж не показывается как «0%»: у него есть здоровье, и это видно игроку.
      const percent = Math.round((world.enemies.hp[guard] / world.enemies.maxHp[guard]) * 100);
      guardHpPercent = Math.min(100, Math.max(1, percent));
    }
  }
  return {
    reached: state.phase === "guard" || state.phase === "cleared",
    clearedSec: state.clearedSec,
    guardHpPercent,
  };
}
