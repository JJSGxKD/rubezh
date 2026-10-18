import type { UpgradeOption } from "@bh/shared-types";
import type { SimInput } from "../sim/step";
import type { World } from "../sim/world";
import { chestSizeOf } from "../sim/chests";
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
 * новичка, который понял главное правило жанра. Он несовершенен намеренно:
 * курс пересчитывается раз в `reactionTicks` тиков, а в счёт идут только
 * `attentionCount` ближайших врагов. Без этого бот видит всё поле, реагирует
 * за один тик и обходит любую толпу пеших врагов медленнее себя — калибровка
 * тогда замечает одних стрелков, а числа остальных врагов в таблице пропадают.
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

/**
 * Дальность, на которой бот замечает сундук и идёт к нему, пока рядом нет
 * угрозы. Сундук не притягивается, и без этого бот не открыл бы ни одного.
 */
const CHEST_SEEK_RADIUS_UNITS = 520;

/** Порядок предпочтений уклоняющегося бота: сначала урон, потом живучесть. */
const DODGING_PRIORITY: readonly UpgradeOption["kind"][] = [
  "weapon_level",
  "weapon_new",
  "passive_new",
  "passive_level",
  "heal",
];

export interface DodgingBotOptions {
  /** раз во сколько тиков бот пересчитывает курс; 1 — каждый тик */
  reactionTicks: number;
  /** сколько ближайших врагов в радиусе опасности он учитывает */
  attentionCount: number;
}

/**
 * Несовершенство уклоняющегося бота. Пара выбрана по смыслу, а не по лучшей
 * строке таблицы замера: 18 тиков — 0,3 с, обычная реакция человека на
 * телефоне, четыре врага — сколько удерживает взгляд в толпе. Таблица шумная
 * (пять seed на оружие), победителя по ней не выбрать; на контенте `dev` пара
 * держит коридор (docs/32-balance.md §3.2, «Замер по сетке»).
 */
export const DODGING_BOT_DEFAULTS: DodgingBotOptions = { reactionTicks: 18, attentionCount: 4 };

export function createBot(skill: BotSkill, options: Partial<DodgingBotOptions> = {}): Bot {
  if (skill === "passive") return passiveBot();
  const merged: DodgingBotOptions = { ...DODGING_BOT_DEFAULTS, ...options };
  // Имена полей берутся из самого объекта: так сообщение всегда называет
  // то поле, которое не прошло проверку.
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Бот калибровки: ${name} должен быть целым числом от 1`);
    }
  }
  return dodgingBot(merged);
}

function passiveBot(): Bot {
  return {
    input: () => ({ moveX: 0, moveY: 0 }),
    // Пассивный берёт первое предложенное: он и не должен играть хорошо.
    choose: (offers) => offers[0].id,
  };
}

const scratchChest = { x: 0, y: 0 };

/**
 * Направление к ближайшему сундуку в пределах `CHEST_SEEK_RADIUS_UNITS`.
 * Возвращает `false`, если сундука рядом нет.
 */
function seekChest(world: World, out: { x: number; y: number }): boolean {
  const player = world.player;
  const pool = world.pickups;
  const reach = CHEST_SEEK_RADIUS_UNITS * world.config.unitScale;
  let nearest = reach;
  let found = false;

  for (let i = 0; i < pool.count; i++) {
    if (pool.alive[i] === 0 || chestSizeOf(pool.kind[i]) === null) continue;
    const dx = pool.x[i] - player.x;
    const dy = pool.y[i] - player.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 1e-3 || distance >= nearest) continue;
    nearest = distance;
    out.x = dx / distance;
    out.y = dy / distance;
    found = true;
  }
  return found;
}

function dodgingBot(options: DodgingBotOptions): Bot {
  const { reactionTicks, attentionCount } = options;
  // Последнее направление: когда вокруг пусто, бот продолжает идти, а не
  // замирает — стоящий на месте «уклоняющийся» не отличался бы от пассивного.
  // Оно же — курс между пересчётами: задержка реакции.
  let lastX = 1;
  let lastY = 0;
  let calls = 0;
  // Ближайшие враги, по возрастанию расстояния: массивы фиксированной длины,
  // созданные один раз, чтобы пересчёт не плодил мусор на каждом тике.
  const attentionDistance = new Float64Array(attentionCount);
  const attentionX = new Float64Array(attentionCount);
  const attentionY = new Float64Array(attentionCount);

  return {
    input(world) {
      const recalculate = calls % reactionTicks === 0;
      calls++;
      if (!recalculate) return { moveX: lastX, moveY: lastY };

      const player = world.player;
      const scale = world.config.unitScale;
      const danger = holdDistance(world);
      const reach = APPROACH_RADIUS_UNITS * scale;
      // Сетка коллизий перестроена на прошлом шаге: тик задержки боту не
      // мешает, а полный проход по пулу на каждом тике стоил бы прогону минуты.
      const found = world.enemyGrid.queryInto(player.x, player.y, reach, world.queryBuffer);

      let noticed = 0;
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

        // Вставка по возрастанию расстояния: при равном — позже выданный
        // встаёт позже, порядок выдачи сетки не теряется. Дальше
        // `attentionCount` бот не смотрит — человек не взвешивает всю толпу.
        let slot = noticed;
        while (slot > 0 && attentionDistance[slot - 1] > distance) slot--;
        if (slot >= attentionCount) continue;
        const last = noticed < attentionCount ? noticed : attentionCount - 1;
        for (let shift = last; shift > slot; shift--) {
          attentionDistance[shift] = attentionDistance[shift - 1];
          attentionX[shift] = attentionX[shift - 1];
          attentionY[shift] = attentionY[shift - 1];
        }
        attentionDistance[slot] = distance;
        attentionX[slot] = dx / distance;
        attentionY[slot] = dy / distance;
        if (noticed < attentionCount) noticed++;
      }

      // Вес обратно расстоянию: вплотную подошедший весит больше десятка
      // дальних, иначе бот идёт в самого опасного врага, спасаясь от толпы.
      let awayX = 0;
      let awayY = 0;
      for (let k = 0; k < noticed; k++) {
        const weight = 1 - attentionDistance[k] / danger;
        awayX += attentionX[k] * weight;
        awayY += attentionY[k] * weight;
      }

      const length = Math.sqrt(awayX * awayX + awayY * awayY);
      if (length >= 1e-3) {
        lastX = awayX / length;
        lastY = awayY / length;
      } else if (seekChest(world, scratchChest)) {
        // Угрозы рядом нет, а сундук в пределах видимости — забираем его.
        lastX = scratchChest.x;
        lastY = scratchChest.y;
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
