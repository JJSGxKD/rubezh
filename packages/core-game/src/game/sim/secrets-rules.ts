import {
  LOADOUT_STATS,
  SECRET_KINDS,
  type EndlessCurveDef,
  type LoadoutStat,
  type SecretKind,
  type SecretsDef,
  type TimelineSegmentDef,
} from "@bh/shared-types";
import type { EnemyType } from "../patterns/enemy-types";
import { LOADOUT_BOUNDS } from "../progression/run-loadout";
import { segmentStartSec } from "./timeline";
import type { ElitePoolStep } from "./world";

/**
 * Правила тайников как данные: проверка `content/secrets.ts` и чтение числа из
 * них, общее для раскладки и шага. Мира и случайности здесь нет.
 */

const ALLOWED_CHEST_SIZES: readonly number[] = [1, 3, 5];

/** Коридор срока волны разлома, секунды: короче — не успеть дойти, длиннее — разлом висит весь забег. */
const RIFT_TIME_LIMIT_MIN_SEC = 20;
const RIFT_TIME_LIMIT_MAX_SEC = 300;

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
  if (!(def.rift.timeLimitSec >= RIFT_TIME_LIMIT_MIN_SEC && def.rift.timeLimitSec <= RIFT_TIME_LIMIT_MAX_SEC)) {
    problems.push(
      `secrets.rift.timeLimitSec — от ${RIFT_TIME_LIMIT_MIN_SEC} до ${RIFT_TIME_LIMIT_MAX_SEC} секунд, сейчас ${def.rift.timeLimitSec}`,
    );
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

/**
 * Таблица «секунда → элиты, которые таймлайн уже выпускал» для волны разлома. Собирается из контента при
 * создании мира и дальше не меняется, в снимок забега не входит: при восстановлении мир собирается заново
 * из того же контента.
 *
 * Берутся элиты (`rank: "elite"`, боссы — нет) из событий отрезков, расписанных руками, и из событий кривой
 * бесконечного режима — с секунды первого срабатывания события. Расчёт отрезка (`planSegment`) не зовётся:
 * он тянет `world.rng`, а таблица обязана быть чистой функцией контента. Шаги идут по секундам и копят
 * типы: элита, однажды вышедшая, остаётся в пуле.
 */
export function buildElitePool(
  timeline: readonly TimelineSegmentDef[],
  curve: EndlessCurveDef,
  enemyTypes: readonly EnemyType[],
): ElitePoolStep[] {
  const indexOf = (enemy: string): number => {
    const index = enemyTypes.findIndex((type) => type.id === enemy);
    return index >= 0 && enemyTypes[index].rank === "elite" ? index : -1;
  };

  const releases: { fromSec: number; type: number }[] = [];
  timeline.forEach((segment, i) => {
    for (const event of segment.events ?? []) {
      const type = indexOf(event.enemy);
      if (type >= 0) releases.push({ fromSec: segmentStartSec(timeline, curve, i), type });
    }
  });
  for (const event of curve.events) {
    const type = indexOf(event.enemy);
    // Событие кривой срабатывает на отрезке, где (шаг + 1) кратно `everySegments`: первый раз — на шаге
    // `everySegments − 1` от начала кривой.
    const firstStep = Math.max(1, event.everySegments) - 1;
    if (type >= 0) releases.push({ fromSec: segmentStartSec(timeline, curve, timeline.length + firstStep), type });
  }
  // Устойчивая сортировка: при равных секундах порядок событий в контенте сохраняется.
  releases.sort((a, b) => a.fromSec - b.fromSec);

  const steps: ElitePoolStep[] = [];
  for (const release of releases) {
    const last = steps[steps.length - 1];
    if (last !== undefined && last.fromSec === release.fromSec) {
      if (!last.types.includes(release.type)) last.types.push(release.type);
      continue;
    }
    const known = last === undefined ? [] : last.types;
    steps.push({ fromSec: release.fromSec, types: known.includes(release.type) ? [...known] : [...known, release.type] });
  }
  return steps;
}

/**
 * Типы элит для волны разлома на этой секунде забега: все, что таймлайн к ней уже выпускал. Разлом открыт
 * раньше первой элиты — берётся первая элита таймлайна. Таймлайна или элит нет — пул пуст, волны не будет.
 */
export function elitePoolAt(pool: readonly ElitePoolStep[], elapsedSec: number): readonly number[] {
  if (pool.length === 0) return [];
  let found = -1;
  for (let i = 0; i < pool.length && pool[i].fromSec <= elapsedSec; i++) found = i;
  return found < 0 ? pool[0].types.slice(0, 1) : pool[found].types;
}
