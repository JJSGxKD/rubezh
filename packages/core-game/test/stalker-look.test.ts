import type { EnemyDef } from "@bh/shared-types";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { STALKER } from "../src/content/stalker";
import { artStageFor, enemyFrameName } from "../src/game/render/art-atlas";
import { HIT_FLASH_TICKS, hitFlashStyle, UNKILLABLE_FLASH_TICKS } from "../src/game/render/hit-flash";
import { ENEMY_LOOKS, enemyColor, enemyRim, UNKILLABLE_LOOK, WORLD_COLORS } from "../src/game/render/looks";
import { drawShape } from "../src/game/render/shapes";
import { STATUS_TONE, STATUS_TONE_COLORS } from "../src/game/render/status-tones";
import {
  DISSOLVE_TICKS,
  dissolveView,
  fadeAlpha,
  omenDrawn,
  omenFogScale,
  omenProgress,
  omenRayAlpha,
  omenRayLength,
  omenView,
  stalkerFadeAlpha,
} from "../src/game/render/stalker-look";
import { buildBossSnapshot } from "../src/game/run/boss";
import { isBoss } from "../src/game/patterns";
import { summonStalker } from "../src/game/sim/stalker";
import { spawnStalker } from "../src/game/sim/stalker-body";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, TICK_HZ, TICK_SEC, type World } from "../src/game/sim/world";

// Облик Карачуна на канве (Р205, tasks/T-0425): знак неубиваемого, предвестие инеем и растворение.
// Рисует Phaser; здесь — всё, что можно проверить без него: цвета, правила выбора, прогресс по таймерам мира
// и геометрия фигуры через запись вызовов Graphics.

function channels(color: number): { r: number; g: number; b: number } {
  return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff };
}

/** Относительная яркость по WCAG: так сравнивают контраст, а не «светлоту» HSL. */
function luminance(color: number): number {
  const { r, g, b } = channels(color);
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: number, b: number): number {
  const [hi, lo] = luminance(a) >= luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (hi + 0.05) / (lo + 0.05);
}

function maxChannelDiff(a: number, b: number): number {
  const x = channels(a);
  const y = channels(b);
  return Math.max(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b));
}

const RAT: EnemyDef = { id: "rat", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const KARACHUN: EnemyDef = { id: "karachun", hp: 1, speed: 110, damage: 0, xp: 0, pattern: "stalker" };
const BOSS: EnemyDef = { id: "boss", hp: 1_000, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", rank: "boss" };

const APPEAR = STALKER.appear;
const OMEN_TICKS = Math.round(APPEAR.omenSec * TICK_HZ);
const FADE_TICKS = Math.round(APPEAR.fadeSec * TICK_HZ);

function makeWorld(): World {
  const world = createWorld({
    seed: 7,
    enemies: [RAT, KARACHUN, BOSS],
    stalker: STALKER,
    config: { progressionEnabled: false },
  });
  world.cheats.godMode = true;
  return world;
}

/** Мир в начале предвестия: перескок на отметку и один шаг. */
function omenWorld(): World {
  const world = makeWorld();
  const tick = world.stalker.nextOmenTick;
  world.stats.tick = tick;
  world.stats.elapsedSec = tick * TICK_SEC;
  stepWorld(world, IDLE_INPUT);
  expect(world.stalker.phase).toBe("omen");
  return world;
}

describe("знак неубиваемого: цвета", () => {
  it("у Карачуна форма «капюшон» и тело из палитры знака", () => {
    expect(ENEMY_LOOKS.stalker).toEqual({ shape: "hood", color: UNKILLABLE_LOOK.body });
    expect(UNKILLABLE_LOOK.body).toBe(0x241c38);
    expect(UNKILLABLE_LOOK.shade).toBe(0x150f24);
    expect(UNKILLABLE_LOOK.deep).toBe(0x0b0816);
    expect(UNKILLABLE_LOOK.light).toBe(0x4d4170);
    expect(UNKILLABLE_LOOK.frost).toBe(0xcfe9ff);
  });

  it("тело темнее земли и любого цвета врага из enemyColor — рядового, элиты и босса", () => {
    const body = luminance(UNKILLABLE_LOOK.body);
    expect(body).toBeLessThan(luminance(WORLD_COLORS.ground));
    for (const pattern of Object.keys(ENEMY_LOOKS) as (keyof typeof ENEMY_LOOKS)[]) {
      if (pattern === "stalker") continue;
      for (const rank of [undefined, "elite", "boss"] as const) {
        expect(body, `${pattern}/${String(rank)}`).toBeLessThan(luminance(enemyColor(pattern, rank)));
      }
    }
    for (const enemy of ENEMIES) {
      if (enemy.pattern === "stalker") continue;
      const rank = enemy.rank;
      expect(body, enemy.id).toBeLessThan(luminance(enemyColor(enemy.pattern, rank, enemy.id)));
    }
  });

  it("кайма неубиваемого лунная, толщиной 2, не золото; у элиты и босса — по-прежнему золото", () => {
    expect(UNKILLABLE_LOOK.rim).toEqual({ color: 0xe6e0ff, width: 2 });
    expect(enemyRim(undefined, true)).toEqual({ color: 0xe6e0ff, width: 2 });
    expect(enemyRim(undefined, true)?.color).not.toBe(0xffd15c);
    expect(enemyRim("elite")).toEqual({ color: 0xffd15c, width: 2 });
    expect(enemyRim("boss")).toEqual({ color: 0xffd15c, width: 3 });
    expect(enemyRim(undefined)).toBeNull();
    expect(enemyRim(undefined, false)).toBeNull();
  });

  it("контраст каймы к телу не меньше 3:1", () => {
    expect(contrast(UNKILLABLE_LOOK.rim.color, UNKILLABLE_LOOK.body)).toBeGreaterThanOrEqual(3);
  });

  it("провал под ногами: тёмный эллипс с бледным кольцом", () => {
    expect(UNKILLABLE_LOOK.pit).toEqual({ color: 0x0b0816, ring: 0xe6e0ff });
  });

  it("иней отличается от тона холода состояний; на теле его нет", () => {
    const chill = STATUS_TONE_COLORS[STATUS_TONE.chill] ?? 0;
    expect(maxChannelDiff(UNKILLABLE_LOOK.frost, chill)).toBeGreaterThanOrEqual(0x30);
    // Заморозка (#b8ecff) близка к инею — поэтому на теле инея нет, только в предвестии.
    for (const color of [UNKILLABLE_LOOK.body, UNKILLABLE_LOOK.shade, UNKILLABLE_LOOK.deep, UNKILLABLE_LOOK.light]) {
      expect(maxChannelDiff(color, UNKILLABLE_LOOK.frost), color.toString(16)).toBeGreaterThanOrEqual(0x60);
      expect(maxChannelDiff(color, STATUS_TONE_COLORS[STATUS_TONE.frozen] ?? 0), color.toString(16)).toBeGreaterThanOrEqual(0x60);
    }
  });
});

describe("фигура «капюшон»", () => {
  /** Запись вызовов Graphics: фигуру проверяем по точкам, не поднимая Phaser. */
  function record(radius: number): { points: { x: number; y: number }[]; calls: string[] } {
    const points: { x: number; y: number }[] = [];
    const calls: string[] = [];
    const target: Record<string, unknown> = {};
    const graphics = new Proxy(target, {
      get: (_, name) => (...args: unknown[]) => {
        calls.push(String(name));
        if (name === "fillPoints" || name === "strokePoints") points.push(...(args[0] as { x: number; y: number }[]));
        if (name === "fillCircle") {
          const [x, y, r] = args as number[];
          points.push({ x: x - r, y: y - r }, { x: x + r, y: y + r });
        }
        if (name === "fillRect") {
          const [x, y, w, h] = args as number[];
          points.push({ x, y }, { x: x + w, y: y + h });
        }
        if (name === "lineBetween") {
          const [x1, y1, x2, y2] = args as number[];
          points.push({ x: x1, y: y1 }, { x: x2, y: y2 });
        }
        return graphics;
      },
    });
    drawShape(graphics as unknown as Parameters<typeof drawShape>[0], {
      shape: "hood",
      radius,
      color: UNKILLABLE_LOOK.body,
      rim: UNKILLABLE_LOOK.rim,
    });
    return { points, calls };
  }

  it("целиком в квадрате текстуры 2r × 2r, высокая и узкая", () => {
    const r = 16;
    const { points, calls } = record(r);
    expect(calls).toContain("fillPoints");
    expect(calls).toContain("strokePoints");
    const eps = 1e-6;
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(-eps);
      expect(point.y).toBeGreaterThanOrEqual(-eps);
      expect(point.x).toBeLessThanOrEqual(2 * r + eps);
      expect(point.y).toBeLessThanOrEqual(2 * r + eps);
    }
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    expect(height).toBeGreaterThan(width);
    expect(height).toBeGreaterThanOrEqual(1.8 * r);
  });
});

describe("предвестие: прогресс по таймерам мира", () => {
  it("0 в начале фазы omen, 1 в конце, между — линейно", () => {
    expect(omenProgress(OMEN_TICKS, OMEN_TICKS)).toBe(0);
    expect(omenProgress(0, OMEN_TICKS)).toBe(1);
    expect(omenProgress(OMEN_TICKS / 2, OMEN_TICKS)).toBeCloseTo(0.5, 6);
    expect(omenProgress(-5, OMEN_TICKS)).toBe(1);
    expect(omenProgress(OMEN_TICKS * 2, OMEN_TICKS)).toBe(0);
    expect(omenProgress(3, 0)).toBe(1);
  });

  it("мир в предвестии: точка выхода из состояния, прогресс идёт 0 → 1", () => {
    const world = omenWorld();
    const first = omenView(world);
    expect(first).not.toBeNull();
    expect(first?.x).toBe(world.stalker.x);
    expect(first?.y).toBe(world.stalker.y);
    expect(first?.progress).toBeLessThan(0.05);
    for (let i = 0; i < OMEN_TICKS - 2; i++) stepWorld(world, IDLE_INPUT);
    expect(world.stalker.phase).toBe("omen");
    expect(omenView(world)?.progress).toBeGreaterThan(0.95);
    stepWorld(world, IDLE_INPUT);
    stepWorld(world, IDLE_INPUT);
    expect(world.stalker.phase).toBe("chase");
    expect(omenView(world)).toBeNull();
  });

  it("повторное предвестие после отброса считается так же", () => {
    const world = omenWorld();
    for (let i = 0; i < OMEN_TICKS; i++) stepWorld(world, IDLE_INPUT);
    expect(world.stalker.phase).toBe("chase");
    const slot = world.stalkerBody.slot;
    const far = (APPEAR.farDistance + 10) * world.config.unitScale;
    world.enemies.x[slot] = world.player.x + far;
    world.enemies.y[slot] = world.player.y;
    stepWorld(world, IDLE_INPUT);
    expect(world.stalker.phase).toBe("omen");
    expect(world.stalker.relocations).toBe(1);
    expect(omenView(world)?.progress).toBeLessThan(0.05);
    for (let i = 0; i < OMEN_TICKS - 2; i++) stepWorld(world, IDLE_INPUT);
    expect(omenView(world)?.progress).toBeGreaterThan(0.95);
  });

  it("вне предвестия — ничего", () => {
    const world = makeWorld();
    expect(omenView(world)).toBeNull();
  });

  it("туман растёт от 0,4 до 1,2, иней — длиннее и ярче к концу", () => {
    expect(omenFogScale(0)).toBeCloseTo(0.4, 6);
    expect(omenFogScale(1)).toBeCloseTo(1.2, 6);
    expect(omenRayLength(0)).toBeLessThan(omenRayLength(0.5));
    expect(omenRayLength(0.5)).toBeLessThan(omenRayLength(1));
    expect(omenRayLength(1)).toBeCloseTo(1, 6);
    expect(omenRayAlpha(0)).toBeLessThan(omenRayAlpha(1));
    expect(omenRayAlpha(1)).toBeLessThanOrEqual(1);
    expect(omenRayAlpha(0)).toBeGreaterThan(0);
  });

  it("при выходе туман рассеивается за 0,3 с: масштаб растёт, прозрачность к нулю", () => {
    expect(DISSOLVE_TICKS).toBe(Math.round(0.3 * TICK_HZ));
    const start = dissolveView(0);
    const end = dissolveView(1);
    expect(end.scale).toBeGreaterThan(start.scale);
    expect(start.alpha).toBeGreaterThan(0);
    expect(end.alpha).toBe(0);
  });
});

describe("растворение: прозрачность по времени фазы fading", () => {
  it("убывает от 1 до 0 за fadeSec", () => {
    expect(fadeAlpha(FADE_TICKS, FADE_TICKS)).toBe(1);
    expect(fadeAlpha(0, FADE_TICKS)).toBe(0);
    let last = 1;
    for (let left = FADE_TICKS; left >= 0; left--) {
      const alpha = fadeAlpha(left, FADE_TICKS);
      expect(alpha).toBeLessThanOrEqual(last);
      last = alpha;
    }
    expect(fadeAlpha(FADE_TICKS / 2, FADE_TICKS)).toBeCloseTo(0.5, 6);
  });

  it("мир: вне фазы fading — 1, в фазе — по остатку", () => {
    const world = omenWorld();
    expect(stalkerFadeAlpha(world)).toBe(1);
    world.stalker.phase = "fading";
    world.stalker.phaseTicks = FADE_TICKS;
    expect(stalkerFadeAlpha(world)).toBe(1);
    world.stalker.phaseTicks = Math.round(FADE_TICKS / 2);
    expect(stalkerFadeAlpha(world)).toBeCloseTo(0.5, 1);
    world.stalker.phaseTicks = 0;
    expect(stalkerFadeAlpha(world)).toBe(0);
  });
});

describe("предвестие и провал обязательны для чтения боя", () => {
  it("предвестие рисуется при выключенных «Телеграфах» и «Эффектах оружия»", () => {
    for (const telegraphs of [true, false]) {
      for (const weaponEffects of [true, false]) {
        expect(omenDrawn("omen", { telegraphs, weaponEffects }), `${String(telegraphs)}/${String(weaponEffects)}`).toBe(true);
      }
    }
    for (const phase of ["off", "waiting", "chase", "fading"] as const) {
      expect(omenDrawn(phase, { telegraphs: false, weaponEffects: false }), phase).toBe(false);
    }
  });
});

describe("вспышка попадания", () => {
  it("у неубиваемого — кайма на 6 тиков, а не белая заливка", () => {
    expect(UNKILLABLE_FLASH_TICKS).toBe(6);
    for (let age = 0; age < UNKILLABLE_FLASH_TICKS; age++) expect(hitFlashStyle(true, age), String(age)).toBe("rim");
    expect(hitFlashStyle(true, UNKILLABLE_FLASH_TICKS)).toBe("none");
    expect(hitFlashStyle(true, 1_000)).toBe("none");
  });

  it("у прочих — белая заливка, как было", () => {
    for (let age = 0; age < HIT_FLASH_TICKS; age++) expect(hitFlashStyle(false, age), String(age)).toBe("fill");
    expect(hitFlashStyle(false, HIT_FLASH_TICKS)).toBe("none");
  });

  it("кайма вспышки ярче и толще обычной", () => {
    expect(luminance(UNKILLABLE_LOOK.rimFlash.color)).toBeGreaterThan(luminance(UNKILLABLE_LOOK.rim.color));
    expect(UNKILLABLE_LOOK.rimFlash.width).toBeGreaterThan(UNKILLABLE_LOOK.rim.width);
  });
});

describe("арт-режим", () => {
  const frames = new Set<string>();
  for (const pack of ["core", "late", "r157", "stages"]) {
    const atlas = JSON.parse(readFileSync(new URL(`../../../design/art/out/atlas-${pack}.json`, import.meta.url), "utf8")) as { frames: Record<string, unknown> };
    for (const name of Object.keys(atlas.frames)) frames.add(name);
  }

  // Пока дизайнер не положил в атлас кадры `karachun`, ArtMode не берёт его и рендер рисует фигуру. Появился
  // кадр — это исключение уходит вместе с этим тестом.
  it("пока в атласе нет кадра karachun, кадра нет ни на одной ступени — рисуется фигура", () => {
    for (let stage = 0; stage < 6; stage++) {
      expect(artStageFor(stage, (s) => frames.has(enemyFrameName("karachun", s, 0))), `ступень ${String(stage)}`).toBe(-1);
    }
  });
});

describe("у Карачуна нет полосы здоровья", () => {
  it("живой Карачун без боссов — полосы нет, и боссом он не считается", () => {
    const world = makeWorld();
    const slot = spawnStalker(world, world.stalkerBody.typeIndex, 200, 0);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(isBoss(world.enemyTypes[world.stalkerBody.typeIndex])).toBe(false);
    expect(buildBossSnapshot(world)).toBeNull();
  });
});

describe("команда разработчика summonStalker", () => {
  it("начинает предвестие сейчас же, в обход отметки", () => {
    const world = makeWorld();
    expect(world.stalker.phase).toBe("waiting");
    expect(world.stats.tick).toBeLessThan(world.stalker.nextOmenTick);
    expect(summonStalker(world)).toBe(true);
    expect(world.stalker.phase).toBe("omen");
    expect(omenView(world)?.progress).toBeLessThan(0.05);
    for (let i = 0; i < OMEN_TICKS; i++) stepWorld(world, IDLE_INPUT);
    expect(world.stalker.phase).toBe("chase");
  });

  it("не перебивает идущее появление", () => {
    const world = omenWorld();
    expect(summonStalker(world)).toBe(false);
  });

  it("без правил в мире и без запасных — отказ", () => {
    const world = createWorld({ seed: 7, enemies: [RAT, KARACHUN], config: { progressionEnabled: false } });
    expect(summonStalker(world)).toBe(false);
    expect(world.stalker.phase).toBe("off");
  });

  it("забег без правил (до подключения в T-0424) получает их из запасных и доходит до выхода", () => {
    const world = createWorld({ seed: 7, enemies: [RAT, KARACHUN], config: { progressionEnabled: false } });
    world.cheats.godMode = true;
    expect(summonStalker(world, STALKER)).toBe(true);
    expect(world.stalker.phase).toBe("omen");
    for (let i = 0; i < OMEN_TICKS; i++) stepWorld(world, IDLE_INPUT);
    expect(world.stalker.phase).toBe("chase");
    expect(world.stalkerBody.slot).toBeGreaterThanOrEqual(0);
  });

  it("запасные правила без врага в мире — отказ", () => {
    const world = createWorld({ seed: 7, enemies: [RAT], config: { progressionEnabled: false } });
    expect(summonStalker(world, STALKER)).toBe(false);
  });
});
