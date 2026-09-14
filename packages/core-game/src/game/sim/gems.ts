import type { DropsDef } from "@bh/shared-types";
import { addXp } from "../progression/levels";
import { createDirection, randomDirection } from "./directions";
import { findPickupContentProblems } from "./pickups";
import { NEVER_HIT } from "./pools";
import { vectorLength } from "./vector";
import { clampToBounds, type World } from "./world";

/** Скорость притянутого кристалла в игровых единицах. */
const GEM_SPEED = 420;
/** Запас к радиусу игрока, на котором кристалл считается подобранным. */
const PICKUP_SLACK = 6;

/**
 * Сколько тиков кристалл летит от места смерти до земли — треть секунды.
 * Экспортируется для рендера: дуга полёта рисуется по этому же времени.
 */
export const GEM_LAND_TICKS = 20;

/** Разлёт горсти кристаллов от места смерти, игровые единицы. */
const SCATTER_MIN = 10;
const SCATTER_MAX = 30;
/** Одиночный кристалл падает почти на месте: разлетаться ему не от кого. */
const SINGLE_SCATTER_RATIO = 0.25;
/**
 * Минимальная доля опыта в кристалле горсти. Без неё случайные веса дают
 * «пылинки» по единице рядом с огромным кристаллом, и горсть читается как шум.
 */
const MIN_SHARE_WEIGHT = 0.35;

/** Потолок горсти: больше кристаллов с одного врага не читаются, а только множат объекты. */
export const MAX_GEMS_PER_KILL = 16;

const scratch = createDirection();
const shares = new Float64Array(MAX_GEMS_PER_KILL);
const values = new Float64Array(MAX_GEMS_PER_KILL);

/** Проблемы контента выпадения человеческим языком — для теста контента и создания мира. */
export function findDropsContentProblems(drops: DropsDef): string[] {
  const problems: string[] = [];
  const perKill = drops.gems.maxPerKill;
  if (!Number.isInteger(perKill) || perKill < 1 || perKill > MAX_GEMS_PER_KILL) {
    problems.push(`drops.gems.maxPerKill — целое от 1 до ${MAX_GEMS_PER_KILL}, сейчас ${perKill}`);
  }
  problems.push(...findPickupContentProblems(drops));
  return problems;
}

/**
 * Выпадение опыта с убитого врага: несколько кристаллов разной ценности,
 * разлетающихся от места смерти. Сумма ценности всегда равна `xp` врага —
 * разброс меняет ощущение добычи, а не скорость прокачки.
 *
 * Сколько кристаллов, решает генератор мира: одинаковый seed — одинаковая
 * горсть. Когда делить нечего (опыт 1 или потолок 1), генератор не
 * вызывается вовсе, и последовательность случайных чисел не сдвигается.
 */
export function dropGems(world: World, x: number, y: number, xp: number): void {
  if (xp <= 0) return;

  const maxCount = Math.max(1, Math.min(Math.floor(xp), world.drops.gems.maxPerKill, shares.length));
  const count = maxCount === 1 ? 1 : world.rng.nextInt(1, maxCount + 1);
  splitValue(world, xp, count);

  const scatter = world.config.unitScale * (count === 1 ? SINGLE_SCATTER_RATIO : 1);
  const bounds = world.config.bounds;
  for (let k = 0; k < count; k++) {
    randomDirection(world.rng, scratch);
    const distance = world.rng.nextRange(SCATTER_MIN, SCATTER_MAX) * scatter;
    const landX = clampToBounds(x + scratch.x * distance, bounds.halfWidth);
    const landY = clampToBounds(y + scratch.y * distance, bounds.halfHeight);
    spawnGem(world, landX, landY, values[k], x, y, true);
  }
}

/**
 * Разделить опыт на `count` целых частей не меньше единицы: случайные веса,
 * округление вниз и остаток — самой крупной части. Дробный опыт (такого в
 * контенте нет, но формула не должна его терять) целиком уходит в неё же.
 */
function splitValue(world: World, xp: number, count: number): void {
  if (count === 1) {
    values[0] = xp;
    return;
  }

  let weightSum = 0;
  for (let k = 0; k < count; k++) {
    shares[k] = MIN_SHARE_WEIGHT + world.rng.nextFloat();
    weightSum += shares[k];
  }

  let assigned = 0;
  let largest = 0;
  for (let k = 0; k < count; k++) {
    values[k] = Math.max(1, Math.floor((xp * shares[k]) / weightSum));
    assigned += values[k];
    if (values[k] > values[largest]) largest = k;
  }
  values[largest] = Math.max(1, values[largest] + (xp - assigned));
}

/**
 * Положить кристалл опыта. Когда пул заполнен, значение добавляется к уже
 * лежащему кристаллу, а не теряется: суммарный опыт забега не зависит от того,
 * сколько врагов умерло одновременно.
 *
 * `flying` — кристалл вылетает из точки `originX, originY` и до приземления
 * не подбирается. Без полёта (по умолчанию) он лежит сразу.
 *
 * Слияние идёт по кругу, без поиска ближайшего: поиск на каждом убийстве —
 * это проход по всему пулу в горячем цикле, а на глаз разницы нет.
 */
export function spawnGem(
  world: World,
  x: number,
  y: number,
  value: number,
  originX = x,
  originY = y,
  flying = false,
): void {
  if (value <= 0) return;

  const gems = world.gems;
  const capacity = gems.alive.length;

  for (let probe = 0; probe < capacity; probe++) {
    const slot = (gems.count + probe) % capacity;
    if (gems.alive[slot] === 1) continue;

    gems.x[slot] = x;
    gems.y[slot] = y;
    gems.prevX[slot] = x;
    gems.prevY[slot] = y;
    gems.originX[slot] = originX;
    gems.originY[slot] = originY;
    gems.bornTick[slot] = flying ? world.stats.tick : NEVER_HIT;
    gems.value[slot] = value;
    gems.attracted[slot] = 0;
    gems.alive[slot] = 1;
    gems.count = Math.max(gems.count, slot + 1);
    gems.aliveCount++;
    return;
  }

  mergeIntoExisting(world, value);
}

function mergeIntoExisting(world: World, value: number): void {
  const gems = world.gems;
  const capacity = gems.alive.length;

  for (let probe = 0; probe < capacity; probe++) {
    const slot = (world.gemMergeCursor + probe) % capacity;
    if (gems.alive[slot] === 0) continue;

    gems.value[slot] += value;
    world.gemMergeCursor = (slot + 1) % capacity;
    return;
  }
}

/** Кристалл ещё летит от места смерти и не может быть подобран. */
export function isGemFlying(world: World, index: number): boolean {
  return world.stats.tick - world.gems.bornTick[index] < GEM_LAND_TICKS;
}

/**
 * Притяжение и подбор. Кристалл в радиусе притяжения начинает лететь к игроку
 * и больше не останавливается, даже если игрок ушёл: иначе кристаллы
 * «отпускает» на границе радиуса и они дёргаются туда-сюда.
 *
 * За радиусом удержания кристалл исчезает. В бесконечном мире вернуться за
 * ним нельзя — он остался дальше, чем игрок вообще видит, — а слот в пуле он
 * занимает до конца забега (docs/26-stage2-plan.md, WP4.1). Таймера жизни у
 * кристаллов нет сознательно: пул и так с потолком и слиянием, а таймер стал
 * бы невидимым правилом «подбирай быстрее», которого никто не просил.
 */
export function updateGems(world: World, dtSec: number): void {
  const gems = world.gems;
  const player = world.player;
  const pickupRadius = world.playerStats.pickupRadius;
  const collectDistance = world.config.player.radius + PICKUP_SLACK * world.config.unitScale;
  const speed = GEM_SPEED * world.config.unitScale;
  const retention = world.config.view.retentionRadius;

  for (let i = 0; i < gems.count; i++) {
    if (gems.alive[i] === 0) continue;

    gems.prevX[i] = gems.x[i];
    gems.prevY[i] = gems.y[i];

    const dx = player.x - gems.x[i];
    const dy = player.y - gems.y[i];
    const distance = vectorLength(dx, dy);

    if (distance > retention) {
      gems.alive[i] = 0;
      gems.aliveCount--;
      continue;
    }
    if (isGemFlying(world, i)) continue;
    if (distance <= collectDistance) {
      collect(world, i);
      continue;
    }
    if (gems.attracted[i] === 0) {
      if (distance > pickupRadius) continue;
      gems.attracted[i] = 1;
    }

    const step = Math.min(speed * dtSec, distance);
    gems.x[i] += (dx / distance) * step;
    gems.y[i] += (dy / distance) * step;
  }
}

function collect(world: World, index: number): void {
  const gems = world.gems;
  const value = gems.value[index];
  gems.alive[index] = 0;
  gems.aliveCount--;
  addXp(world, value);
}
