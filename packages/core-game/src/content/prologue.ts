import type { DifficultyId, EnemyDef, PrologueDef, RubezhDef, TimelineSegmentDef } from "@bh/shared-types";

/**
 * Пролог первого забега — данные геймдизайнера (docs/35-stage4-plan.md Р151,
 * design/art/meta-v2.md §4.2). Три минуты, рассказанные как история: сила
 * растёт с первых секунд, на 1:15 приходит элита с большим сундуком, на 2:40 —
 * настоящий Страж рубежа, конец — победа. Смерть в прологе невозможна (оберег),
 * рейтинг и задания пролог не трогает.
 *
 * Числа стартовые, калибрует геймдизайнер; коридоры — `BALANCE_TARGETS.prologue`,
 * свод — `docs/32-balance.md`, раздел «Пролог». Таймлайн того же вида, что в
 * `waves.ts`, но кривая бесконечного режима в прологе не работает: после
 * последнего отрезка поток держится как есть.
 */

/** Сложность пролога: движок ставит её сам, что бы ни пришло из оболочки. */
export const PROLOGUE_DIFFICULTY_ID: DifficultyId = "easy";

/**
 * Поток, который держится до конца пролога: каждый отрезок повторяет состав
 * предыдущего. Отрезок без спавна остановил бы поток, поэтому событиям отрезков
 * 75, 150 и 160 с поток приходится повторять.
 */
const RATS_AND_WALKERS = [
  { enemy: "swarm_rat", perSec: 1.6 },
  { enemy: "bone_walker", perSec: 0.4 },
];
const WITH_WOLVES = [...RATS_AND_WALKERS, { enemy: "dasher_wolf", perSec: 0.3 }];

const TIMELINE: TimelineSegmentDef[] = [
  // Пустое начало — самый дешёвый способ потерять игрока, но и толпа в первые
  // секунды ни к чему: игрок учится ходить.
  { fromSec: 0, maxAlive: 25, spawns: [{ enemy: "swarm_rat", perSec: 0.6 }] },
  { fromSec: 45, maxAlive: 60, spawns: RATS_AND_WALKERS },
  // Первая элита: с неё падает большой сундук.
  { fromSec: 75, maxAlive: 60, spawns: RATS_AND_WALKERS, events: [{ kind: "ring", enemy: "elite_ghoul", count: 1 }] },
  { fromSec: 100, maxAlive: 80, spawns: WITH_WOLVES },
  // «Волна Нави» кольцом — последняя проверка перед Стражем.
  { fromSec: 150, maxAlive: 80, spawns: WITH_WOLVES, events: [{ kind: "ring", enemy: "swarm_rat", count: 30 }] },
  // Страж — финал: потолок выше предыдущего, чтобы толпа у самого потолка не
  // отменила событие, которое приходит один раз и на котором держится весь пролог.
  { fromSec: 160, maxAlive: 120, spawns: WITH_WOLVES, events: [{ kind: "ring", enemy: "rubezh_guard", count: 1 }] },
];

export const PROLOGUE: PrologueDef = {
  timeline: TIMELINE,
  // Калибровка по боту (docs/32-balance.md «Пролог»): при 0,12 (≈ 170 из 1400) бот,
  // набравший за три минуты четыре оружия и 16–19 уровней, снимает Стража за 2–10 секунд,
  // а коридор — 25–50 с. При 2 медиана боя около 33 с, и конец забега в 174–214 с.
  guardHpMul: 2,
  hpFloorRatio: 0.25,
  firstChestSize: 3,
  // Опыт растёт быстрее обычной кривой, но так же геометрически: первый уровень почти сразу.
  levelCurve: { baseXp: 3, growth: 1.18 },
  pickupRadiusMul: 1.5,
  recommendFirstOffer: "new_weapon",
};

const ALLOWED_CHEST_SIZES: readonly number[] = [1, 3, 5];

/** Во сколько раз Страж пролога может быть крепче обычного: выше — бой с ним перестаёт быть тремя минутами. */
export const GUARD_HP_MUL_MAX = 4;

/** Допустимое окно оберега: ниже — смерть почти не отличить от обычной, выше — бой теряет смысл. */
export const HP_FLOOR_RATIO_RANGE = { min: 0.1, max: 0.5 } as const;

/**
 * Замечания к описанию пролога. Пусто — всё в порядке. Сообщение называет отрезок
 * или поле, чтобы правщик контента видел, что чинить.
 */
export function findPrologueProblems(def: PrologueDef, enemies: readonly EnemyDef[], rubezh: RubezhDef): string[] {
  const problems: string[] = [];
  const byId = new Map(enemies.map((enemy) => [enemy.id, enemy]));
  const timeline = def.timeline;

  if (timeline.length === 0) {
    problems.push("prologue.timeline — пуст: забегу не с чего начинаться");
  } else if (timeline[0].fromSec !== 0) {
    problems.push("prologue.timeline — первый отрезок обязан начинаться с нулевой секунды");
  }

  // Сколько раз и где встречается Страж: он один, последним событием последнего отрезка.
  let guardAppearances = 0;
  let guardIsLast = false;
  timeline.forEach((segment, i) => {
    const where = `prologue.timeline — отрезок на ${segment.fromSec}s`;
    if (i > 0 && segment.fromSec <= timeline[i - 1].fromSec) {
      problems.push(`${where}: секунды отрезков должны строго возрастать`);
    }
    if (segment.maxAlive !== undefined && !(segment.maxAlive >= 1)) {
      problems.push(`${where}: maxAlive должен быть не меньше единицы`);
    }
    const events = segment.events ?? [];
    if (segment.spawns.length === 0 && events.length === 0) {
      problems.push(`${where}: нет ни спавна, ни события — отрезок ничего не делает`);
    }

    for (const spawn of segment.spawns) {
      const enemy = byId.get(spawn.enemy);
      if (enemy === undefined) {
        problems.push(`${where}: врага ${spawn.enemy} нет в контенте`);
        continue;
      }
      if (enemy.rank !== undefined) problems.push(`${where}: ${enemy.id} приходит только событием, а не потоком`);
      if (!(spawn.perSec === undefined || spawn.perSec >= 0)) problems.push(`${where}: perSec ${spawn.enemy} меньше нуля`);
    }
    events.forEach((event, k) => {
      const enemy = byId.get(event.enemy);
      if (enemy === undefined) {
        problems.push(`${where}: врага ${event.enemy} нет в контенте`);
        return;
      }
      if (event.kind === "cordon") problems.push(`${where}: строй стражей в прологе не нужен`);
      if (!(event.count >= 1)) problems.push(`${where}: у события ${event.enemy} count меньше единицы`);
      if (event.enemy === rubezh.guard) {
        guardAppearances++;
        guardIsLast = i === timeline.length - 1 && k === events.length - 1;
      } else if (enemy.rank === "boss") {
        problems.push(`${where}: босс ${enemy.id} в прологе лишний — в нём один Страж`);
      }
    });
  });
  if (guardAppearances !== 1) {
    problems.push(`prologue.timeline — Страж ${rubezh.guard} должен прийти один раз, сейчас ${guardAppearances}`);
  } else if (!guardIsLast) {
    problems.push(`prologue.timeline — Страж ${rubezh.guard} должен быть последним событием последнего отрезка`);
  }

  if (!(def.hpFloorRatio >= HP_FLOOR_RATIO_RANGE.min && def.hpFloorRatio <= HP_FLOOR_RATIO_RANGE.max)) {
    problems.push(
      `prologue.hpFloorRatio — от ${HP_FLOOR_RATIO_RANGE.min} до ${HP_FLOOR_RATIO_RANGE.max}, сейчас ${def.hpFloorRatio}`,
    );
  }
  if (!(def.guardHpMul > 0 && def.guardHpMul <= GUARD_HP_MUL_MAX)) {
    problems.push(`prologue.guardHpMul — больше 0 и не больше ${GUARD_HP_MUL_MAX}, сейчас ${def.guardHpMul}`);
  }
  if (!ALLOWED_CHEST_SIZES.includes(def.firstChestSize)) {
    problems.push(`prologue.firstChestSize — размер 1, 3 или 5, сейчас ${def.firstChestSize}`);
  }
  if (!(def.levelCurve.baseXp > 0)) problems.push(`prologue.levelCurve.baseXp — больше 0, сейчас ${def.levelCurve.baseXp}`);
  if (!(def.levelCurve.growth > 1)) {
    problems.push(`prologue.levelCurve.growth — больше 1, кривая опыта должна расти, сейчас ${def.levelCurve.growth}`);
  }
  if (!(def.pickupRadiusMul >= 1 && def.pickupRadiusMul <= 3)) {
    problems.push(`prologue.pickupRadiusMul — от 1 до 3, сейчас ${def.pickupRadiusMul}`);
  }
  return problems;
}
