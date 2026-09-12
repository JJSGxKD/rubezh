import type { MapCameraDef, MapDef } from "@bh/shared-types";

/**
 * Карта, разложенная из контента в числа симуляции.
 *
 * Симуляция не знает ни о камере, ни о размере экрана. Единственное, что она
 * берёт из параметров камеры, — радиус кольца спавна, и берёт его от
 * **максимально возможной** видимой области: ни зум, ни поворот экрана, ни
 * широкий монитор не должны показывать момент появления врага, а спавн обязан
 * быть одинаковым на всех устройствах (docs/26-stage2-plan.md, WP4.3).
 */

/** Запас за пределами максимальной видимой области, в игровых единицах. */
export const SPAWN_MARGIN_UNITS = 64;

/**
 * Во сколько раз радиус удержания больше радиуса спавна. Внутри него мир
 * живёт: дальше отставшие враги переносятся вперёд, а снаряды и кристаллы
 * гибнут. Меньше — и враг, от которого игрок убежал, исчезал бы почти на
 * глазах; больше — и за спиной копится толпа, которая не участвует в игре, но
 * занимает пул и время кадра.
 */
const RETENTION_RATIO = 1.9;

/**
 * Минимальный размер ограниченной оси карты — в радиусах спавна. Карта уже
 * этого не даёт кольцу спавна ни одной допустимой дуги, и враги полезли бы
 * либо за границу, либо в видимую область.
 */
const MIN_HALF_EXTENT_RATIO = 1.25;

/** Границы мира в пикселях; `Infinity` — ось не ограничена. */
export interface WorldBounds {
  halfWidth: number;
  halfHeight: number;
}

export interface ViewConfig {
  /** радиус кольца спавна: максимальная видимая область плюс запас */
  spawnRadius: number;
  /** радиус удержания: дальше него мир не копится */
  retentionRadius: number;
}

export interface ResolvedMap {
  id: string;
  bounds: WorldBounds;
  view: ViewConfig;
}

/**
 * Половина диагонали максимальной видимой области в игровых единицах.
 *
 * Видимая область нормализована по площади (решение Р14), поэтому при
 * фиксированной площади диагональ тем длиннее, чем вытянутее экран, — максимум
 * достигается на крайнем допустимом соотношении сторон. Экран вытянутее
 * предела видит меньшую площадь, и его диагональ короче.
 */
export function maxVisibleHalfDiagonalUnits(camera: MapCameraDef): number {
  const aspect = Math.max(1, camera.maxAspect);
  return 0.5 * Math.sqrt(camera.viewAreaMoving * (aspect + 1 / aspect));
}

export function spawnRadiusUnits(camera: MapCameraDef): number {
  return maxVisibleHalfDiagonalUnits(camera) + SPAWN_MARGIN_UNITS;
}

export function resolveMap(def: MapDef, unitScale: number): ResolvedMap {
  const problems = findMapContentProblems([def]);
  if (problems.length > 0) {
    throw new Error(`Некорректный контент карт:\n${problems.join("\n")}`);
  }

  const spawnRadius = spawnRadiusUnits(def.camera) * unitScale;
  return {
    id: def.id,
    bounds: {
      halfWidth: (def.bounds?.halfWidth ?? Infinity) * unitScale,
      halfHeight: (def.bounds?.halfHeight ?? Infinity) * unitScale,
    },
    view: { spawnRadius, retentionRadius: spawnRadius * RETENTION_RATIO },
  };
}

/**
 * Проблемы контента карт человеческим языком — тем же способом, что у врагов
 * и оружия: сообщение читает геймдизайнер в выводе CI.
 */
export function findMapContentProblems(defs: readonly MapDef[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const def of defs) {
    if (seen.has(def.id)) problems.push(`карта ${def.id}: id повторяется`);
    seen.add(def.id);
    problems.push(...findCameraProblems(def));
    problems.push(...findBoundsProblems(def));
  }
  return problems;
}

function findCameraProblems(def: MapDef): string[] {
  const problems: string[] = [];
  const camera = def.camera;

  if (!(camera.viewAreaMoving > 0)) {
    problems.push(`карта ${def.id}: viewAreaMoving должен быть больше нуля`);
  }
  if (!(camera.viewAreaIdle > 0)) {
    problems.push(`карта ${def.id}: viewAreaIdle должен быть больше нуля`);
  }
  if (camera.viewAreaIdle > camera.viewAreaMoving) {
    // Стоя игрок видит ближе, на бегу — дальше (решение Р3). Обратное
    // отношение — не «другой вкус», а перепутанные местами числа: камера
    // отъезжала бы на остановке и наезжала на бегу.
    problems.push(`карта ${def.id}: viewAreaIdle должен быть не больше viewAreaMoving`);
  }
  if (!(camera.maxAspect >= 1)) {
    problems.push(`карта ${def.id}: maxAspect должен быть не меньше единицы`);
  }
  for (const key of ["followSmoothingSec", "zoomSmoothingSec", "zoomInDelaySec"] as const) {
    if (!(camera[key] >= 0)) problems.push(`карта ${def.id}: ${key} не может быть отрицательным`);
  }
  return problems;
}

function findBoundsProblems(def: MapDef): string[] {
  const problems: string[] = [];
  if (def.bounds === undefined) return problems;

  const minimum = spawnRadiusUnits(def.camera) * MIN_HALF_EXTENT_RATIO;
  for (const key of ["halfWidth", "halfHeight"] as const) {
    const value = def.bounds[key];
    if (value === undefined) continue;
    if (!(value >= minimum)) {
      problems.push(
        `карта ${def.id}: ${key} должен быть не меньше ${Math.ceil(minimum)} — иначе спавну некуда ставить врагов`,
      );
    }
  }
  return problems;
}
