import type { SecretsDef } from "@bh/shared-types";
import { LOADOUT_STATS } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { SECRETS } from "../src/content/secrets";
import { LOADOUT_BOUNDS } from "../src/game/progression/run-loadout";
import { findSecretsProblems } from "../src/game/sim/secrets";

// Тайники рубежа — данные геймдизайнера (docs/35-stage4-plan.md, Р153).
// Проверка называет поле, в котором ошибка: правит данные человек, а не код.

/** Копия боевых данных с правкой — чтобы каждый тест ломал ровно одно поле. */
function patched(patch: Partial<SecretsDef>): SecretsDef {
  return { ...SECRETS, ...patch };
}

function problemsOf(def: SecretsDef): string {
  return findSecretsProblems(def).join("\n");
}

describe("данные тайников", () => {
  it("боевые данные проходят проверку", () => {
    expect(findSecretsProblems(SECRETS)).toEqual([]);
  });

  it("пустой набор колец допустим: мир без тайников", () => {
    expect(findSecretsProblems(patched({ rings: [] }))).toEqual([]);
  });

  it("первое кольцо — только капище: найти его должен каждый", () => {
    const first = SECRETS.rings[0];
    expect(first.count).toBe(1);
    expect(first.kinds).toEqual([{ kind: "shrine", weight: expect.any(Number) }]);
  });

  it("всего 3–5 тайников за забег (Р153)", () => {
    const total = SECRETS.rings.reduce((sum, ring) => sum + ring.count, 0);
    expect(total).toBeGreaterThanOrEqual(3);
    expect(total).toBeLessThanOrEqual(5);
  });

  it("кольца растут и не пересекаются", () => {
    let previousEnd = 0;
    for (const ring of SECRETS.rings) {
      expect(ring.minRadius).toBeGreaterThan(previousEnd);
      expect(ring.maxRadius).toBeGreaterThan(ring.minRadius);
      previousEnd = ring.maxRadius;
    }
  });

  it("первое кольцо — в одном-двух экранах от старта", () => {
    const first = SECRETS.rings[0];
    expect(first.minRadius).toBeGreaterThanOrEqual(700);
    expect(first.maxRadius).toBeLessThanOrEqual(1_100);
  });

  it("благословения: известные параметры в пределах движка, id без повторов", () => {
    const ids = new Set<string>();
    for (const blessing of SECRETS.blessings) {
      expect(ids.has(blessing.id), blessing.id).toBe(false);
      ids.add(blessing.id);
      expect(blessing.nameKey).toBe(`blessing.${blessing.id}`);
      const entries = Object.entries(blessing.modifiers);
      expect(entries.length, blessing.id).toBeGreaterThan(0);
      for (const [stat, value] of entries) {
        expect(LOADOUT_STATS as readonly string[], `${blessing.id}.${stat}`).toContain(stat);
        expect(value, `${blessing.id}.${stat}`).toBeGreaterThan(0);
        expect(value, `${blessing.id}.${stat}`).toBeLessThanOrEqual(LOADOUT_BOUNDS[stat as keyof typeof LOADOUT_BOUNDS]);
      }
    }
  });

  it("в наборе шесть благословений владельца", () => {
    expect(SECRETS.blessings.map((blessing) => blessing.id)).toEqual(["fury", "wind", "harvest", "fortress", "keen", "flame"]);
  });

  it("«Зоркость» — перезарядка на 8 % короче", () => {
    expect(SECRETS.blessings.find((blessing) => blessing.id === "keen")?.modifiers).toEqual({ cooldown: 0.08 });
  });

  it("на выбор хватает благословений", () => {
    expect(SECRETS.blessings.length).toBeGreaterThanOrEqual(SECRETS.shrine.offers);
    expect(SECRETS.shrine.offers).toBe(3);
  });

  it("виды колец известны движку, а веса больше нуля", () => {
    for (const ring of SECRETS.rings) {
      for (const entry of ring.kinds) expect(entry.weight).toBeGreaterThan(0);
    }
  });
});

describe("проверка данных тайников называет поле", () => {
  it("кольцо с концом раньше начала", () => {
    const rings = SECRETS.rings.map((ring, i) => (i === 1 ? { ...ring, maxRadius: ring.minRadius - 1 } : ring));
    expect(problemsOf(patched({ rings }))).toContain("secrets.rings[1].maxRadius");
  });

  it("кольцо, налезающее на прошлое", () => {
    const rings = SECRETS.rings.map((ring, i) => (i === 1 ? { ...ring, minRadius: SECRETS.rings[0].maxRadius - 1 } : ring));
    expect(problemsOf(patched({ rings }))).toContain("secrets.rings[1].minRadius");
  });

  it("кольцо без тайников и дробное число тайников", () => {
    const empty = SECRETS.rings.map((ring, i) => (i === 0 ? { ...ring, count: 0 } : ring));
    expect(problemsOf(patched({ rings: empty }))).toContain("secrets.rings[0].count");
    const fractional = SECRETS.rings.map((ring, i) => (i === 2 ? { ...ring, count: 1.5 } : ring));
    expect(problemsOf(patched({ rings: fractional }))).toContain("secrets.rings[2].count");
  });

  it("кольцо без видов и вес не больше нуля", () => {
    const none = SECRETS.rings.map((ring, i) => (i === 1 ? { ...ring, kinds: [] } : ring));
    expect(problemsOf(patched({ rings: none }))).toContain("secrets.rings[1].kinds");
    const zero = SECRETS.rings.map((ring, i) => (i === 1 ? { ...ring, kinds: [{ kind: "hoard" as const, weight: 0 }] } : ring));
    expect(problemsOf(patched({ rings: zero }))).toContain("secrets.rings[1].kinds[0].weight");
  });

  it("неизвестный вид тайника", () => {
    const rings = SECRETS.rings.map((ring, i) =>
      i === 1 ? { ...ring, kinds: [{ kind: "ghost" as unknown as "hoard", weight: 1 }] } : ring,
    );
    expect(problemsOf(patched({ rings }))).toContain("secrets.rings[1].kinds[0].kind");
  });

  it("круги и сроки стояния", () => {
    expect(problemsOf(patched({ shrine: { ...SECRETS.shrine, radius: 0 } }))).toContain("secrets.shrine.radius");
    expect(problemsOf(patched({ shrine: { ...SECRETS.shrine, holdSec: 0 } }))).toContain("secrets.shrine.holdSec");
    expect(problemsOf(patched({ hoard: { ...SECRETS.hoard, radius: -1 } }))).toContain("secrets.hoard.radius");
    expect(problemsOf(patched({ hoard: { ...SECRETS.hoard, holdSec: Number.NaN } }))).toContain("secrets.hoard.holdSec");
    expect(problemsOf(patched({ stone: { radius: 0 } }))).toContain("secrets.stone.radius");
  });

  it("размер сундука клада и число карточек капища", () => {
    expect(problemsOf(patched({ hoard: { ...SECRETS.hoard, chestSize: 2 as unknown as 3 } }))).toContain("secrets.hoard.chestSize");
    expect(problemsOf(patched({ shrine: { ...SECRETS.shrine, offers: 0 } }))).toContain("secrets.shrine.offers");
    expect(problemsOf(patched({ shrine: { ...SECRETS.shrine, offers: SECRETS.blessings.length + 1 } }))).toContain("secrets.shrine.offers");
  });

  it("огонёк: срок появления и скорость", () => {
    expect(problemsOf(patched({ wisp: { ...SECRETS.wisp, appearSec: -1 } }))).toContain("secrets.wisp.appearSec");
    expect(problemsOf(patched({ wisp: { ...SECRETS.wisp, speed: 0 } }))).toContain("secrets.wisp.speed");
  });

  it("расстояние между тайниками", () => {
    expect(problemsOf(patched({ minGapUnits: -1 }))).toContain("secrets.minGapUnits");
  });

  it("благословение: повтор id, неизвестный параметр, прибавка вне предела, пустое", () => {
    const first = SECRETS.blessings[0];
    expect(problemsOf(patched({ blessings: [...SECRETS.blessings, { ...first }] }))).toContain(`secrets.blessings[${SECRETS.blessings.length}].id`);

    const unknown = SECRETS.blessings.map((b, i) => (i === 0 ? { ...b, modifiers: { teleport: 1 } as unknown as typeof b.modifiers } : b));
    expect(problemsOf(patched({ blessings: unknown }))).toContain("secrets.blessings[0].modifiers.teleport");

    const huge = SECRETS.blessings.map((b, i) => (i === 0 ? { ...b, modifiers: { damage: LOADOUT_BOUNDS.damage + 1 } } : b));
    expect(problemsOf(patched({ blessings: huge }))).toContain("secrets.blessings[0].modifiers.damage");

    const negative = SECRETS.blessings.map((b, i) => (i === 0 ? { ...b, modifiers: { damage: -0.1 } } : b));
    expect(problemsOf(patched({ blessings: negative }))).toContain("secrets.blessings[0].modifiers.damage");

    const empty = SECRETS.blessings.map((b, i) => (i === 0 ? { ...b, modifiers: {} } : b));
    expect(problemsOf(patched({ blessings: empty }))).toContain("secrets.blessings[0].modifiers");
  });
});
