import { WEAPONS, type RunDevCheats, type RunDevCommand } from "@bh/core-game";

/**
 * Сцены стенда эффектов (docs/17-testing-strategy.md, «Стенд эффектов»,
 * docs/35-stage4-plan.md Р142): забег на паузе с нужным оружием или событием,
 * врагами вокруг и шагом по тикам для раскадровки.
 */
export interface FxScene {
  id: string;
  /** что смотреть на раскадровке — одна фраза для агента и человека */
  note: string;
  /** оружие, с которым начинается забег; у эволюции — её базовое, эволюцию выдаёт команда */
  startingWeaponId: string;
  /** команды разработчика на старте, после выдачи оружия */
  commands: RunDevCommand[];
  /** читы сцены сверх общих (бессмертие, замороженные враги, пауза спавна) */
  cheats?: Partial<RunDevCheats>;
  /** сколько тиков снимать; кадр — каждые 3 тика (50 мс при 60 Гц) */
  ticks: number;
}

const WEAPON_SCENE_TICKS = 90;
const EVENT_SCENE_TICKS = 60;
const SWARM_AROUND = 10;

/** Сцена оружия: последний уровень и рой вокруг. Каталог растёт вместе с `WEAPONS`. */
function weaponScene(weapon: (typeof WEAPONS)[number]): FxScene {
  return {
    id: weapon.id,
    note: `Оружие «${weapon.id}» последнего уровня против роя из ${SWARM_AROUND} крыс: вспышка, след и гибель врагов.`,
    startingWeaponId: weapon.evolvedFrom ?? weapon.id,
    commands: [
      { kind: "giveWeapon", id: weapon.id, level: 99 },
      { kind: "spawnEnemy", id: "swarm_rat", count: SWARM_AROUND },
    ],
    ticks: WEAPON_SCENE_TICKS,
  };
}

const EVENT_SCENES: FxScene[] = [
  {
    id: "dynamite",
    note: "Подобранный динамит среди двадцати рядовых: взрыв и гибель окружения.",
    startingWeaponId: "spark",
    commands: [
      { kind: "spawnEnemy", id: "swarm_rat", count: 20 },
      { kind: "spawnPickup", pickup: "dynamite" },
    ],
    ticks: EVENT_SCENE_TICKS,
  },
  {
    id: "magnet",
    note: "Подобранный магнит и сорок кристаллов: притяжение всей добычи к игроку.",
    startingWeaponId: "spark",
    commands: [
      { kind: "spawnGems", value: 1, count: 40 },
      { kind: "spawnPickup", pickup: "magnet" },
    ],
    ticks: EVENT_SCENE_TICKS,
  },
  {
    id: "elite_death",
    note: "Гибель крупного врага с одного удара: вспышка смерти и добыча.",
    startingWeaponId: "spark",
    commands: [{ kind: "spawnEnemy", id: "tank_ghoul", count: 1 }],
    cheats: { oneHitKill: true },
    ticks: EVENT_SCENE_TICKS,
  },
];

export const FX_SCENES: readonly FxScene[] = [...WEAPONS.map(weaponScene), ...EVENT_SCENES];

export function fxScene(id: string): FxScene | null {
  return FX_SCENES.find((scene) => scene.id === id) ?? null;
}
