import type { SecretsDef } from "@bh/shared-types";
import { drawWeighted } from "../progression/levels";
import { createDirection, randomDirection } from "./directions";
import type { WorldBounds } from "./map-types";
import type { Rng } from "./rng";
import { radiusOf } from "./secrets-rules";
import { clampToBounds, type SecretSite, type SecretState } from "./world";

/**
 * Раскладка тайников: один бросок при создании мира, по кольцам от старта, из
 * собственного потока случайности (`STREAM_SALT.secret`). Общий `world.rng` здесь
 * не трогается — поток приходит параметром, мира в этом файле нет.
 */

/**
 * Сколько раз пробуется новое место, прежде чем смириться с соседством.
 * Конечное число: цикл в симуляции не должен зависеть от удачи генератора.
 */
const MAX_PLACE_ATTEMPTS = 12;
const scratch = createDirection();

/**
 * Бросить раскладку тайников. Поток приходит снаружи — создание мира заводит
 * его от `deriveSeed(seed, STREAM_SALT.secret)`; без колец поток не тратится.
 */
export function createSecretState(rng: Rng, def: SecretsDef, unitScale: number, bounds: WorldBounds): SecretState {
  const sites: SecretSite[] = [];
  const gap = def.minGapUnits * unitScale;

  def.rings.forEach((ring, ringIndex) => {
    for (let slot = 0; slot < ring.count; slot++) {
      const kind = ring.kinds[drawWeighted(rng, ring.kinds)].kind;
      // Огоньку места на карте нет: слот кольца лишь решает, что он будет в этом забеге.
      const site: SecretSite = {
        kind,
        ring: ringIndex,
        x: 0,
        y: 0,
        active: kind !== "wisp",
        visible: false,
        found: false,
        used: false,
        holdTicks: 0,
      };
      if (site.active) {
        const margin = radiusOf(def, kind) * unitScale;
        for (let attempt = 0; attempt < MAX_PLACE_ATTEMPTS; attempt++) {
          randomDirection(rng, scratch);
          const distance = rng.nextRange(ring.minRadius, ring.maxRadius) * unitScale;
          // Граница карты, если она есть, не выпускает тайник за край.
          site.x = clampToBounds(scratch.x * distance, Math.max(0, bounds.halfWidth - margin));
          site.y = clampToBounds(scratch.y * distance, Math.max(0, bounds.halfHeight - margin));
          if (isClear(sites, site.x, site.y, gap)) break;
        }
      }
      sites.push(site);
    }
  });

  return {
    rng,
    sites,
    manualBlessing: false,
    offer: null,
    blessings: [],
    foundLog: [],
    usedLog: [],
    blessingLog: [],
  };
}

function isClear(sites: readonly SecretSite[], x: number, y: number, gap: number): boolean {
  const gapSq = gap * gap;
  for (const other of sites) {
    if (!other.active) continue;
    const dx = other.x - x;
    const dy = other.y - y;
    if (dx * dx + dy * dy < gapSq) return false;
  }
  return true;
}
