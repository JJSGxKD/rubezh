import { LOADOUT_STATS, SECRET_KINDS, type LoadoutStat, type SecretKind, type SecretsDef } from "@bh/shared-types";
import { LOADOUT_BOUNDS } from "../progression/run-loadout";

/**
 * Правила тайников как данные: проверка `content/secrets.ts` и чтение числа из
 * них, общее для раскладки и шага. Мира и случайности здесь нет.
 */

const ALLOWED_CHEST_SIZES: readonly number[] = [1, 3, 5];

export function findSecretsProblems(def: SecretsDef): string[] {
  const problems: string[] = [];
  const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

  let previousEnd = 0;
  def.rings.forEach((ring, i) => {
    const path = `secrets.rings[${i}]`;
    if (!positive(ring.minRadius) || ring.minRadius <= previousEnd) {
      problems.push(`${path}.minRadius — больше конца прошлого кольца (${previousEnd}), сейчас ${ring.minRadius}`);
    }
    if (!(Number.isFinite(ring.maxRadius) && ring.maxRadius > ring.minRadius)) {
      problems.push(`${path}.maxRadius — больше minRadius (${ring.minRadius}), сейчас ${ring.maxRadius}`);
    }
    previousEnd = Number.isFinite(ring.maxRadius) ? ring.maxRadius : previousEnd;

    if (!Number.isInteger(ring.count) || ring.count < 1) {
      problems.push(`${path}.count — целое не меньше 1, сейчас ${ring.count}`);
    }
    if (ring.kinds.length === 0) problems.push(`${path}.kinds — нужен хотя бы один вид`);
    ring.kinds.forEach((entry, k) => {
      // Тип узок (место на земле), но данные приходят с границы: сверяемся по полному перечню.
      const kind = entry.kind as SecretKind;
      if (kind === "wisp") {
        problems.push(`${path}.kinds[${k}].kind — огонёк не вид кольца: он один на забег и появляется у игрока`);
      } else if (!SECRET_KINDS.includes(kind)) {
        problems.push(`${path}.kinds[${k}].kind — один из ${SECRET_KINDS.join(", ")}, сейчас ${String(kind)}`);
      }
      if (!positive(entry.weight)) problems.push(`${path}.kinds[${k}].weight — больше 0, сейчас ${entry.weight}`);
    });
  });

  if (!(Number.isFinite(def.minGapUnits) && def.minGapUnits >= 0)) {
    problems.push(`secrets.minGapUnits — не меньше 0, сейчас ${def.minGapUnits}`);
  }

  for (const key of ["shrine", "hoard"] as const) {
    if (!positive(def[key].radius)) problems.push(`secrets.${key}.radius — больше 0, сейчас ${def[key].radius}`);
    if (!positive(def[key].holdSec)) problems.push(`secrets.${key}.holdSec — больше 0, сейчас ${def[key].holdSec}`);
  }
  if (!Number.isInteger(def.shrine.offers) || def.shrine.offers < 1 || def.shrine.offers > def.blessings.length) {
    problems.push(`secrets.shrine.offers — целое от 1 до числа благословений (${def.blessings.length}), сейчас ${def.shrine.offers}`);
  }
  if (!ALLOWED_CHEST_SIZES.includes(def.hoard.chestSize)) {
    problems.push(`secrets.hoard.chestSize — размер 1, 3 или 5, сейчас ${def.hoard.chestSize}`);
  }
  if (!positive(def.stone.radius)) problems.push(`secrets.stone.radius — больше 0, сейчас ${def.stone.radius}`);

  if (!positive(def.tree.radius)) problems.push(`secrets.tree.radius — больше 0, сейчас ${def.tree.radius}`);
  if (!(Number.isFinite(def.tree.healPerSec) && def.tree.healPerSec > 0 && def.tree.healPerSec <= 1)) {
    problems.push(`secrets.tree.healPerSec — доля здоровья в секунду, от 0 (не включая) до 1, сейчас ${def.tree.healPerSec}`);
  }
  if (!positive(def.tree.shieldEverySec)) problems.push(`secrets.tree.shieldEverySec — больше 0, сейчас ${def.tree.shieldEverySec}`);

  if (!positive(def.rift.radius)) problems.push(`secrets.rift.radius — больше 0, сейчас ${def.rift.radius}`);
  if (!Number.isInteger(def.rift.elites) || def.rift.elites < 1) {
    problems.push(`secrets.rift.elites — целое не меньше 1, сейчас ${def.rift.elites}`);
  }
  // Кольцо волны должно лежать за кругом разлома: иначе элиты выходят прямо на игрока, стоящего в нём.
  if (!(Number.isFinite(def.rift.ringRadius) && def.rift.ringRadius > def.rift.radius)) {
    problems.push(`secrets.rift.ringRadius — больше радиуса круга (${def.rift.radius}), сейчас ${def.rift.ringRadius}`);
  }
  if (!ALLOWED_CHEST_SIZES.includes(def.rift.chestSize)) {
    problems.push(`secrets.rift.chestSize — размер 1, 3 или 5, сейчас ${def.rift.chestSize}`);
  }
  if (!(Number.isFinite(def.wisp.appearSec) && def.wisp.appearSec >= 0)) {
    problems.push(`secrets.wisp.appearSec — не меньше 0, сейчас ${def.wisp.appearSec}`);
  }
  if (!positive(def.wisp.speed)) problems.push(`secrets.wisp.speed — больше 0, сейчас ${def.wisp.speed}`);

  const seen = new Set<string>();
  def.blessings.forEach((blessing, i) => {
    const path = `secrets.blessings[${i}]`;
    if (seen.has(blessing.id)) problems.push(`${path}.id — повторяется: ${blessing.id}`);
    seen.add(blessing.id);
    if (blessing.nameKey === "") problems.push(`${path}.nameKey — нужен ключ названия`);

    const entries = Object.entries(blessing.modifiers);
    if (entries.length === 0) problems.push(`${path}.modifiers — нужен хотя бы один параметр`);
    for (const [stat, value] of entries) {
      if (!(LOADOUT_STATS as readonly string[]).includes(stat)) {
        problems.push(`${path}.modifiers.${stat} — неизвестный параметр`);
        continue;
      }
      const bound = LOADOUT_BOUNDS[stat as LoadoutStat];
      if (!(typeof value === "number" && value > 0 && value <= bound)) {
        problems.push(`${path}.modifiers.${stat} — от 0 (не включая) до ${bound}, сейчас ${String(value)}`);
      }
    }
  });
  return problems;
}

/** Радиус круга вида, единицы; у огонька круга нет. */
export function radiusOf(def: SecretsDef, kind: SecretKind): number {
  switch (kind) {
    case "shrine":
      return def.shrine.radius;
    case "hoard":
      return def.hoard.radius;
    case "stone":
      return def.stone.radius;
    case "tree":
      return def.tree.radius;
    case "rift":
      return def.rift.radius;
    case "wisp":
      return 0;
  }
}
