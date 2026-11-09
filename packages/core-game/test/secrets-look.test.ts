import { SECRET_KINDS, type SecretKind } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { SECRETS } from "../src/content/secrets";
import { CONTENT_SNAPSHOT } from "../src/content/snapshot";
import { createRunWorld } from "../src/game/run-world";
import { buildRadarSnapshot } from "../src/game/radar";
import { ART_PPU } from "../src/game/render/art-atlas";
import { ENEMY_LOOKS, GEM_TIERS, SECRET_LOOKS, WORLD_COLORS } from "../src/game/render/looks";
import { holdProgress, SECRET_CELL_UNITS, secretFrameName, secretHoldSec, secretLookState } from "../src/game/render/secrets-look";
import type { SecretSite, World } from "../src/game/sim/world";
import { RADAR_BLIP } from "../src/run-api";

// Облик тайников рубежа (docs/35-stage4-plan.md, Р153; design/art/meta-v2.md
// §5.3): тайник читается на земле, не путается ни с врагом, ни с опытом, ни с
// героем, а действующий светится бирюзой оберегов или фиолетом Нави.

function channels(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

/** Расстояние между цветами в RGB: чем больше, тем различимее; ниже порога — спутать можно. */
function distance(a: number, b: number): number {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

/** Яркость по Рек. 709 — «темнее героя» меряется ей. */
function luminance(color: number): number {
  const [r, g, b] = channels(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const MIN_DISTANCE = 90;
const REDS = [...Object.values(ENEMY_LOOKS).map((look) => look.color), WORLD_COLORS.threat];
/** Цвета опыта: кристаллы всех ступеней (лайм, бирюза, фиолет, золото), снаряд игрока и кольцо опыта. */
const XP_COLORS = [...GEM_TIERS.map((tier) => tier.color), WORLD_COLORS.projectile, WORLD_COLORS.xpRing];

describe("тона тайников", () => {
  it("у каждого вида есть тон, тёмный тон и знак; знаки разные", () => {
    expect(Object.keys(SECRET_LOOKS).sort()).toEqual([...SECRET_KINDS].sort());
    const signs = SECRET_KINDS.map((kind) => SECRET_LOOKS[kind].sign);
    expect(new Set(signs).size).toBe(SECRET_KINDS.length);
    expect(SECRET_LOOKS.shrine.sign).toBe("pillar");
    expect(SECRET_LOOKS.hoard.sign).toBe("diamond");
    expect(SECRET_LOOKS.tree.sign).toBe("fir");
    expect(SECRET_LOOKS.rift.sign).toBe("crack");
    expect(SECRET_LOOKS.stone.sign).toBe("triangle");
    expect(SECRET_LOOKS.wisp.sign).toBe("tail");
  });

  for (const kind of SECRET_KINDS) {
    it(`«${kind}»: не красный враг, не опыт, не белый герой — ни в покое, ни в действии`, () => {
      const look = SECRET_LOOKS[kind];
      for (const tone of [look.color, look.dark]) {
        for (const red of REDS) expect(distance(tone, red), `${kind}: ${tone.toString(16)} ~ враг ${red.toString(16)}`).toBeGreaterThan(MIN_DISTANCE);
        for (const yellow of XP_COLORS) expect(distance(tone, yellow), `${kind}: ${tone.toString(16)} ~ опыт ${yellow.toString(16)}`).toBeGreaterThan(MIN_DISTANCE);
        expect(distance(tone, WORLD_COLORS.player), `${kind}: ${tone.toString(16)} ~ герой`).toBeGreaterThan(MIN_DISTANCE);
      }
    });

    it(`«${kind}»: в покое темнее героя, а действующий светлее покоя`, () => {
      const look = SECRET_LOOKS[kind];
      expect(luminance(look.dark)).toBeLessThan(luminance(WORLD_COLORS.player));
      expect(luminance(look.color)).toBeLessThan(luminance(WORLD_COLORS.player));
      expect(luminance(look.color)).toBeGreaterThan(luminance(look.dark));
    });
  }

  it("действующий тайник — бирюза оберегов или фиолет Нави: синий не слабее красного, а зелёного нет сверх бирюзы", () => {
    for (const kind of SECRET_KINDS) {
      const [r, g, b] = channels(SECRET_LOOKS[kind].color);
      expect(b, `${kind}: нужен холодный тон`).toBeGreaterThanOrEqual(r);
      expect(g, `${kind}: зелёный выше синего — это уже опыт, а не обереги`).toBeLessThanOrEqual(b + 0x40);
    }
    // Разлом Нави — фиолетовый: красного в нём больше, чем зелёного.
    const [rr, rg] = channels(SECRET_LOOKS.rift.color);
    expect(rr).toBeGreaterThan(rg);
  });
});

describe("состояние облика", () => {
  const site = (patch: Partial<SecretSite> = {}): SecretSite => ({
    kind: "shrine",
    ring: 0,
    x: 0,
    y: 0,
    active: true,
    visible: false,
    found: false,
    used: false,
    holdTicks: 0,
    opened: false,
    wave: [],
    waveTicks: 0,
    ...patch,
  });

  it("не тронутый и найденный без стояния — «found»; стоит в круге, выдана награда или открыт разлом — «active»", () => {
    expect(secretLookState(site())).toBe("found");
    expect(secretLookState(site({ found: true }))).toBe("found");
    expect(secretLookState(site({ found: true, holdTicks: 30 }))).toBe("active");
    expect(secretLookState(site({ found: true, used: true }))).toBe("active");
    expect(secretLookState(site({ kind: "rift", found: true, opened: true }))).toBe("active");
  });

  it("огонёк: летит — «active», ждёт на краю круга — «hint»", () => {
    expect(secretLookState(site({ kind: "wisp", found: true }), true)).toBe("active");
    expect(secretLookState(site({ kind: "wisp", found: true }), false)).toBe("hint");
  });

  it("имя кадра атласа — как в design/art: secret/<вид>/<состояние>", () => {
    expect(secretFrameName("shrine", "found")).toBe("secret/shrine/found");
    expect(secretFrameName("tree", "active")).toBe("secret/tree/active");
    expect(secretFrameName("wisp", "hint")).toBe("secret/wisp/hint");
  });

  it("ячейка кадра — размер тайника в единицах, как в design/art/src/secrets.mjs", () => {
    expect(SECRET_CELL_UNITS).toEqual({ shrine: 64, hoard: 40, tree: 70, rift: 60, stone: 50, wisp: 18 });
    // Кадр атласа — units × ART_PPU пикселей, поэтому на экране он ровно столько единиц.
    expect(SECRET_CELL_UNITS.shrine * ART_PPU).toBe(160);
  });
});

describe("дуга стояния", () => {
  it("прогресс — доля стояния от нужного, не выше единицы и не ниже нуля", () => {
    expect(holdProgress(0, 3)).toBe(0);
    expect(holdProgress(90, 3)).toBe(0.5);
    expect(holdProgress(180, 3)).toBe(1);
    expect(holdProgress(400, 3)).toBe(1);
    expect(holdProgress(-5, 3)).toBe(0);
  });

  it("стоять нужно у капища и клада; у остальных видов дуги нет", () => {
    expect(secretHoldSec(SECRETS, "shrine")).toBe(SECRETS.shrine.holdSec);
    expect(secretHoldSec(SECRETS, "hoard")).toBe(SECRETS.hoard.holdSec);
    for (const kind of ["stone", "tree", "rift", "wisp"] as const) expect(secretHoldSec(SECRETS, kind)).toBeNull();
  });
});

describe("радар: тайники", () => {
  function runWorld(): World {
    return createRunWorld({ seed: 1, mapId: "", difficultyId: "normal", unitScale: 1, content: CONTENT_SNAPSHOT }).world;
  }

  function secretBlips(world: World): number[] {
    const snapshot = buildRadarSnapshot(world);
    const kinds: number[] = [];
    for (let i = 0; i < snapshot.count; i++) kinds.push(snapshot.blips[i * 3 + 2]);
    return kinds.filter((kind) => kind >= RADAR_BLIP.shrine);
  }

  it("у каждого вида тайника — свой код точки; коды не пересекаются с врагами и подборами", () => {
    const codes = SECRET_KINDS.map((kind) => RADAR_BLIP[kind as SecretKind]);
    expect(new Set(codes).size).toBe(SECRET_KINDS.length);
    for (const code of codes) expect(code).toBeGreaterThan(RADAR_BLIP.freeze);
  });

  it("на радаре только найденный или открытый указателем; закрытые невидимые не рисуются", () => {
    const world = runWorld();
    for (const site of world.secrets.sites) {
      site.visible = false;
      site.found = false;
    }
    expect(secretBlips(world)).toEqual([]);

    const shrine = world.secrets.sites.find((site) => site.kind === "shrine");
    if (shrine === undefined) throw new Error("в раскладке нет капища");
    shrine.visible = true;
    shrine.found = true;
    expect(secretBlips(world)).toEqual([RADAR_BLIP.shrine]);
  });

  it("использованный тайник с радара уходит, а древо, которое не исчезает, остаётся", () => {
    const world = runWorld();
    const [first] = world.secrets.sites.filter((site) => site.kind !== "wisp");
    if (first === undefined) throw new Error("в раскладке нет тайников");
    first.visible = true;
    first.found = true;
    first.kind = "tree";
    first.used = false;
    expect(secretBlips(world)).toEqual([RADAR_BLIP.tree]);

    first.kind = "hoard";
    first.used = true;
    expect(secretBlips(world)).toEqual([]);
  });

  it("огонёк до появления на радаре нет, а когда появился — виден", () => {
    const world = runWorld();
    for (const site of world.secrets.sites) site.visible = false;
    const wisp = world.secrets.sites.find((site) => site.kind === "wisp");
    if (wisp === undefined) throw new Error("в раскладке нет огонька");
    wisp.active = false;
    wisp.visible = true;
    expect(secretBlips(world)).toEqual([]);

    wisp.active = true;
    expect(secretBlips(world)).toEqual([RADAR_BLIP.wisp]);
  });

  it("тайники кладутся первыми: за потолком точек врагов они не теряются", () => {
    const world = runWorld();
    const shrine = world.secrets.sites.find((site) => site.kind === "shrine");
    if (shrine === undefined) throw new Error("в раскладке нет капища");
    shrine.visible = true;
    shrine.found = true;
    const snapshot = buildRadarSnapshot(world);
    expect(snapshot.blips[2]).toBe(RADAR_BLIP.shrine);
  });
});
