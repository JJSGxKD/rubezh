import type { DeviceClass, RunLoadout } from "@bh/shared-types";
import { ACCOUNT_UNLOCKS } from "../../content/unlocks";

/**
 * Профили силы для калибровки подстройки (docs/32-balance.md §3.1, T-0196,
 * Р131, Р183): три игрока, на которых бот меряет лесенку «новичок — средний —
 * полный арсенал».
 *
 * Профили — данные, а не вычисление на лету: каталог предметов живёт на
 * сервере, и движок не может его импортировать. Литералы снаряжения получены
 * из канонического набора (по слоту — главное свойство и первые свойства пула,
 * один бросок), а равенство каталогу держит `scripts/test/power-profiles.test.ts`:
 * поменяли каталог — тест печатает числа для вставки сюда.
 */

export type PowerProfileId = "novice" | "average" | "full" | "veteran";

export interface PowerProfile {
  id: PowerProfileId;
  titleRu: string;
  loadout: RunLoadout;
  /** чем начинать забег профиля; не задано — любым стартовым оружием, как у остальных профилей */
  startingWeaponId?: string;
}

/** Верхний уровень аккаунта берётся из лестницы открытий, а не литералом: добавили строку — профиль уехал вместе с ней. */
const TOP_ACCOUNT_LEVEL = Math.max(...ACCOUNT_UNLOCKS.map((row) => row.level));

export const POWER_PROFILES: Readonly<Record<PowerProfileId, PowerProfile>> = {
  novice: {
    id: "novice",
    titleRu: "новичок",
    loadout: { modifiers: {}, boosts: [], accountLevel: 1 },
  },
  // «Средний» — предположение о типичном игроке: восьмой уровень и шесть
  // редких предметов 10-го уровня с бросками 0,8. Настоящее распределение
  // покажет аналитика после выката (T-0196, вопрос 7).
  average: {
    id: "average",
    titleRu: "средний",
    loadout: {
      modifiers: {
        damage: 0.1072,
        cooldown: 0.0714,
        area: 0.143,
        statusChance: 0.0893,
        damageFire: 0.0893,
        damageCold: 0.0893,
        maxHp: 21.44,
        armor: 1.0718,
        regenPerSec: 0.3572,
        pickupRadius: 0.2144,
        moveSpeed: 0.0357,
      },
      boosts: [],
      accountLevel: 8,
    },
  },
  // Шесть легендарных предметов на потолке уровня предмета для верхнего
  // уровня аккаунта и три буста: потолок силы, до которого игрок доходит.
  full: {
    id: "full",
    titleRu: "полный арсенал",
    loadout: {
      modifiers: {
        damage: 0.2772,
        cooldown: 0.1848,
        area: 0.3696,
        projectileSpeed: 0.462,
        duration: 0.3696,
        statusChance: 0.462,
        damageFire: 0.231,
        damageCold: 0.231,
        damageLightning: 0.231,
        damagePoison: 0.231,
        maxHp: 55.44,
        armor: 2.772,
        regenPerSec: 1.386,
        resistFire: 0.2772,
        resistCold: 0.2772,
        pickupRadius: 0.5544,
        moveSpeed: 0.0924,
      },
      boosts: ["fury", "bulwark", "aegis"],
      accountLevel: TOP_ACCOUNT_LEVEL,
    },
  },
  // Забег владельца на v0.12.2 (Р196, T-0389): «Сложная», `frontier`, 1242 с, уровень забега 64.
  // Не канонический набор каталога, а снаряжение из записи как есть: восемь свойств с малыми
  // прибавками на 9-м уровне аккаунта, три буста. Фикстура записи —
  // `core-game/test/fixtures/veteran-run-v0122.json`, равенство профиля ей держит тест. Это
  // единственный профиль, у которого есть живой образец: по нему сверяется стоящий бот.
  veteran: {
    id: "veteran",
    titleRu: "ветеран",
    startingWeaponId: "hearth",
    loadout: {
      modifiers: {
        area: 0.0645,
        maxHp: 8.73,
        cooldown: 0.0361,
        moveSpeed: 0.0384,
        resistCold: 0.039,
        regenPerSec: 0.3316,
        resistPoison: 0.0323,
        statusChance: 0.069,
      },
      boosts: ["head_start", "lure", "fury"],
      accountLevel: 9,
    },
  },
};

/**
 * Тот же профиль на устройстве другого класса: меняется только `deviceClass`
 * набора. Обычному устройству поле не пишется — как в оболочке (T-0195, решение 2).
 */
export function withDevice(profile: PowerProfile, deviceClass: DeviceClass): PowerProfile {
  const base: RunLoadout = { modifiers: profile.loadout.modifiers, boosts: profile.loadout.boosts };
  if (profile.loadout.accountLevel !== undefined) base.accountLevel = profile.loadout.accountLevel;
  if (deviceClass === "light") base.deviceClass = "light";
  return { ...profile, loadout: base };
}
