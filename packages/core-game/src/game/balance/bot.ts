import type { UpgradeOption } from "@bh/shared-types";
import type { SimInput } from "../sim/step";
import type { World } from "../sim/world";
import { ORBITER_RADIUS } from "../weapons";

/**
 * Бот-игрок для калибровки баланса (docs/26-stage2-plan.md, WP4.6).
 *
 * Бот — не замена плейтесту, а способ получить распределение: сто забегов на
 * ста seed за минуту вместо ста забегов руками за неделю. Ручной плейтест
 * остаётся зоной геймдизайнера (docs/06-team-and-workflow.md §1).
 *
 * Два уровня. **Пассивный** не двигается вовсе — он отвечает на вопрос «есть
 * ли в игре гарантированная смерть»: если он выживает, забег можно не играть.
 * **Уклоняющийся** отходит от ближайших врагов и качает урон — грубая модель
 * новичка, который понял главное правило жанра.
 *
 * Бот детерминирован: ни генератора случайных чисел, ни тригонометрии. Иначе
 * два прогона одного seed давали бы разные числа, и таблица калибровки
 * перестала бы что-либо значить.
 */
export type BotSkill = "passive" | "dodging";

export interface Bot {
  input(world: World): SimInput;
  choose(offers: readonly UpgradeOption[]): string;
}

/**
 * Насколько близко враг должен подойти, чтобы бот начал уходить, — для оружия,
 * бьющего на расстоянии. Дальше этого бот врага просто не считает опасным.
 */
const DANGER_RADIUS_UNITS = 200;

/**
 * Запас поверх радиуса оружия ближнего боя: бот держит врагов у самой кромки
 * своего кольца или ауры, а не убегает от них.
 */
const CONTACT_MARGIN_UNITS = 20;

/**
 * Дальность, на которой бот ищет, к кому подойти. Чистое бегство — не модель
 * игрока, а модель паники: два из трёх стартовых оружий бьют только рядом с
 * врагом, и убегающий бот померил бы не их баланс, а свою же трусость.
 */
const APPROACH_RADIUS_UNITS = 460;

/** Порядок предпочтений уклоняющегося бота: сначала урон, потом живучесть. */
const DODGING_PRIORITY: readonly UpgradeOption["kind"][] = [
  "weapon_level",
  "weapon_new",
  "passive_new",
  "passive_level",
  "heal",
];

export function createBot(skill: BotSkill): Bot {
  return skill === "passive" ? passiveBot() : dodgingBot();
}

function passiveBot(): Bot {
  return {
    input: () => ({ moveX: 0, moveY: 0 }),
    // Пассивный берёт первое предложенное: он и не должен играть хорошо.
    choose: (offers) => offers[0].id,
  };
}

function dodgingBot(): Bot {
  // Последнее направление: когда вокруг пусто, бот продолжает идти, а не
  // замирает — стоящий на месте «уклоняющийся» не отличался бы от пассивного.
  let lastX = 1;
  let lastY = 0;

  return {
    input(world) {
      const player = world.player;
      const scale = world.config.unitScale;
      const danger = holdDistance(world);
      const reach = APPROACH_RADIUS_UNITS * scale;
      // Сетка коллизий перестроена на прошлом шаге: тик задержки боту не
      // мешает, а полный проход по пулу на каждом тике стоил бы прогону минуты.
      const found = world.enemyGrid.queryInto(player.x, player.y, reach, world.queryBuffer);

      let awayX = 0;
      let awayY = 0;
      let nearestX = 0;
      let nearestY = 0;
      let nearest = Infinity;

      for (let k = 0; k < found; k++) {
        const i = world.queryBuffer[k];
        if (world.enemies.alive[i] === 0) continue;

        const dx = player.x - world.enemies.x[i];
        const dy = player.y - world.enemies.y[i];
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < 1e-3 || distance > reach) continue;

        if (distance < nearest) {
          nearest = distance;
          nearestX = -dx / distance;
          nearestY = -dy / distance;
        }
        if (distance > danger) continue;

        // Вес обратно расстоянию: вплотную подошедший весит больше десятка
        // дальних, иначе бот идёт в самого опасного врага, спасаясь от толпы.
        const weight = 1 - distance / danger;
        awayX += (dx / distance) * weight;
        awayY += (dy / distance) * weight;
      }

      const length = Math.sqrt(awayX * awayX + awayY * awayY);
      if (length >= 1e-3) {
        lastX = awayX / length;
        lastY = awayY / length;
      } else if (nearest < Infinity) {
        // Угрозы рядом нет — идём к ближайшему врагу: так работает и орбита, и
        // оружие, бьющее по направлению взгляда.
        lastX = nearestX;
        lastY = nearestY;
      }
      return { moveX: lastX, moveY: lastY };
    },

    choose(offers) {
      for (const kind of DODGING_PRIORITY) {
        const match = offers.find((offer) => offer.kind === kind);
        if (match !== undefined) return match.id;
      }
      return offers[0].id;
    },
  };
}

/**
 * На каком расстоянии бот держит врагов. Дистанция берётся от оружия, а не
 * задаётся числом: с «Искрой» игрок кайтит, с «Оберегом» обязан подпускать —
 * иначе кольцо не касается никого, и таблица меряет не баланс оружия, а
 * скорость бега. Из двух оружий побеждает дальнобойное: подставляться незачем,
 * когда есть чем бить издали.
 */
function holdDistance(world: World): number {
  const scale = world.config.unitScale;
  let hold = 0;
  for (const slot of world.loadout.weapons) {
    const type = world.weaponTypes[slot.typeIndex];
    if (type === undefined) continue;
    const level = type.levels[Math.min(slot.level, type.levels.length) - 1];
    if (level === undefined) continue;

    const reach =
      type.behavior === "orbit"
        ? level.areaRadius + (ORBITER_RADIUS + CONTACT_MARGIN_UNITS) * scale
        : type.behavior === "aura"
          ? level.areaRadius + CONTACT_MARGIN_UNITS * scale
          : DANGER_RADIUS_UNITS * scale;
    if (reach > hold) hold = reach;
  }
  return hold === 0 ? DANGER_RADIUS_UNITS * scale : hold;
}
