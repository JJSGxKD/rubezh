import { addXp } from "../progression/levels";
import { vectorLength } from "./vector";
import type { World } from "./world";

/** Скорость притянутого кристалла в игровых единицах. */
const GEM_SPEED = 420;
/** Запас к радиусу игрока, на котором кристалл считается подобранным. */
const PICKUP_SLACK = 6;

/**
 * Положить кристалл опыта. Когда пул заполнен, значение добавляется к уже
 * лежащему кристаллу, а не теряется: суммарный опыт забега не зависит от того,
 * сколько врагов умерло одновременно.
 *
 * Слияние идёт по кругу, без поиска ближайшего: поиск на каждом убийстве —
 * это проход по всему пулу в горячем цикле, а на глаз разницы нет.
 */
export function spawnGem(world: World, x: number, y: number, value: number): void {
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

/**
 * Притяжение и подбор. Кристалл в радиусе притяжения начинает лететь к игроку
 * и больше не останавливается, даже если игрок ушёл: иначе кристаллы
 * «отпускает» на границе радиуса и они дёргаются туда-сюда.
 */
export function updateGems(world: World, dtSec: number): void {
  const gems = world.gems;
  const player = world.player;
  const pickupRadius = world.playerStats.pickupRadius;
  const collectDistance = world.config.player.radius + PICKUP_SLACK * world.config.unitScale;
  const speed = GEM_SPEED * world.config.unitScale;

  for (let i = 0; i < gems.count; i++) {
    if (gems.alive[i] === 0) continue;

    gems.prevX[i] = gems.x[i];
    gems.prevY[i] = gems.y[i];

    const dx = player.x - gems.x[i];
    const dy = player.y - gems.y[i];
    const distance = vectorLength(dx, dy);

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
