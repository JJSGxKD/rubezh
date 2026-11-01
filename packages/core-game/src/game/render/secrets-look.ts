import type Phaser from "phaser";
import { SECRET_KINDS, type SecretKind, type SecretsDef } from "@bh/shared-types";
import { radiusOf } from "../sim/secrets-rules";
import type { SecretSite, World } from "../sim/world";
import { TICK_HZ } from "../sim/world";
import type { ArtFrame } from "./art-atlas";
import { SECRET_BODY_RADIUS_UNITS, SECRET_LOOKS, type SecretSign } from "./looks";
import { triangle } from "./textures";

/**
 * Облик тайников рубежа на канве (docs/35-stage4-plan.md, Р153;
 * design/art/meta-v2.md §5.3, tasks/T-0260): тайник стоит на земле сразу — это
 * место, а не прятки, — в режиме фигур кругом со знаком вида, в режиме арта —
 * кадром атласа `env`. Действующий — со столбом света; стояние в круге капища
 * и клада — дугой по кругу стояния.
 *
 * Тайник обязан читаться, поэтому столб и дуга не под «Эффектами оружия»:
 * выключатель эффектов боя их не гасит. При «меньше движения» столб светит
 * ровно, не мерцая. Всё здесь — рендер: на исход забега не влияет, а раскладка
 * и состояние — из мира.
 */

/** Состояние облика: `hint` — только у огонька, который ждёт на краю круга. */
export type SecretLookState = "found" | "active" | "hint";

/** Сторона ячейки кадра в игровых единицах — `units` в design/art/src/secrets.mjs. */
export const SECRET_CELL_UNITS: Readonly<Record<SecretKind, number>> = { shrine: 64, hoard: 40, tree: 70, rift: 60, stone: 50, wisp: 18 };

/** Имя кадра в атласе `env`: `secret/<вид>/<состояние>`. */
export function secretFrameName(kind: SecretKind, state: SecretLookState): string {
  return `secret/${kind}/${state}`;
}

/**
 * Какой облик у тайника. Действует: игрок стоит в круге, награда уже выдана
 * или из разлома вышла волна; иначе — найденный и ещё нетронутый выглядят
 * одинаково. Огонёк летит — «active», ждёт на краю круга — «hint».
 */
export function secretLookState(site: Pick<SecretSite, "kind" | "used" | "holdTicks" | "opened">, moving = false): SecretLookState {
  if (site.kind === "wisp") return moving ? "active" : "hint";
  return site.holdTicks > 0 || site.used || site.opened ? "active" : "found";
}

/** Доля стояния от нужного, от нуля до единицы. */
export function holdProgress(holdTicks: number, holdSec: number): number {
  const need = holdSec * TICK_HZ;
  if (need <= 0) return 1;
  return Math.min(1, Math.max(0, holdTicks / need));
}

/** Сколько секунд стоять: у капища и клада; у остальных видов дуги нет. */
export function secretHoldSec(rules: SecretsDef, kind: SecretKind): number | null {
  if (kind === "shrine") return rules.shrine.holdSec;
  if (kind === "hoard") return rules.hoard.holdSec;
  return null;
}

/** Кадры арта по виду и состоянию; нет кадра — рисуется фигура. */
export type SecretArt = Readonly<Record<SecretKind, Partial<Record<SecretLookState, ArtFrame>>>>;

const BODY_KEY = (kind: SecretKind, lit: boolean): string => `bh-secret-${kind}-${lit ? "lit" : "dark"}`;
const BEAM_KEY = "bh-secret-beam";
/** Высота и ширина столба света в игровых единицах. */
const BEAM_HEIGHT_UNITS = 150;
const BEAM_WIDTH_UNITS = 16;
/** Столб мерцает с периодом в полторы секунды; «меньше движения» — ровный. */
const BEAM_PERIOD_TICKS = TICK_HZ * 1.5;
const BEAM_ALPHA = 0.3;
const BEAM_PULSE = 0.12;
const RING_ALPHA = 0.28;
const ARC_ALPHA = 0.95;
const ARC_WIDTH_UNITS = 3;
/** Шаг дуги, при котором она перерисовывается: сотая доля круга. */
const ARC_STEPS = 100;

function mix(from: number, to: number, ratio: number): number {
  const channel = (shift: number): number => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * ratio);
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Знак вида внутри круга радиуса `r`: центр — (r, r) текстуры. */
function drawSign(graphics: Phaser.GameObjects.Graphics, sign: SecretSign, r: number, color: number): void {
  graphics.fillStyle(color, 1);
  graphics.lineStyle(r * 0.16, color, 1);
  switch (sign) {
    case "pillar":
      graphics.fillRect(r * 0.84, r * 0.4, r * 0.32, r * 1.2);
      graphics.fillRect(r * 0.62, r * 0.4, r * 0.76, r * 0.14);
      return;
    case "diamond":
      graphics.fillTriangle(r, r * 0.42, r * 1.42, r, r, r * 1.58);
      graphics.fillTriangle(r, r * 0.42, r * 0.58, r, r, r * 1.58);
      return;
    case "fir":
      graphics.fillTriangle(r, r * 0.38, r * 1.38, r * 1.0, r * 0.62, r * 1.0);
      graphics.fillTriangle(r, r * 0.7, r * 1.5, r * 1.5, r * 0.5, r * 1.5);
      return;
    case "crack":
      graphics.beginPath();
      graphics.moveTo(r * 1.2, r * 0.38);
      graphics.lineTo(r * 0.8, r * 0.85);
      graphics.lineTo(r * 1.2, r * 1.1);
      graphics.lineTo(r * 0.82, r * 1.62);
      graphics.strokePath();
      return;
    case "triangle":
      graphics.fillTriangle(r, r * 0.45, r * 1.45, r * 1.5, r * 0.55, r * 1.5);
      return;
    case "tail":
      graphics.fillCircle(r * 1.2, r, r * 0.3);
      graphics.fillTriangle(r * 1.0, r * 0.82, r * 1.0, r * 1.18, r * 0.35, r);
      return;
  }
}

/** Фигура тайника: круг в тоне вида и знак внутри; в покое темнее, действующий светится. */
function ensureBodyTexture(scene: Phaser.Scene, kind: SecretKind, lit: boolean, unitScale: number): void {
  const key = BODY_KEY(kind, lit);
  if (scene.textures.exists(key)) return;
  const look = SECRET_LOOKS[kind];
  const r = SECRET_BODY_RADIUS_UNITS * unitScale;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  graphics.fillStyle(0x0d0d1f, 0.85);
  graphics.fillCircle(r, r, r);
  graphics.fillStyle(lit ? mix(look.dark, look.color, 0.45) : look.dark, 1);
  graphics.fillCircle(r, r, r * 0.88);
  graphics.lineStyle(Math.max(1, r * 0.1), look.color, lit ? 1 : 0.55);
  graphics.strokeCircle(r, r, r * 0.88);
  drawSign(graphics, look.sign, r, lit ? mix(look.color, 0xffffff, 0.55) : mix(look.color, look.dark, 0.25));
  graphics.generateTexture(key, Math.ceil(r * 2), Math.ceil(r * 2));
  graphics.destroy();
}

/** Столб света: вытянутый прямоугольник с убывающей прозрачностью, без сложения цветов (`ADD`). */
function ensureBeamTexture(scene: Phaser.Scene, unitScale: number): void {
  if (scene.textures.exists(BEAM_KEY)) return;
  const width = Math.ceil(BEAM_WIDTH_UNITS * unitScale);
  const height = Math.ceil(BEAM_HEIGHT_UNITS * unitScale);
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  const bands = 5;
  for (let i = 0; i < bands; i++) {
    const top = Math.floor((height * i) / bands);
    graphics.fillStyle(0xffffff, 1 - i / bands);
    graphics.fillRect(0, top, width, Math.ceil(height / bands));
  }
  graphics.generateTexture(BEAM_KEY, width, height);
  graphics.destroy();
}

interface SiteView {
  body: Phaser.GameObjects.Image;
  beam: Phaser.GameObjects.Image;
  /** прошлое положение — по нему видно, летит огонёк или ждёт */
  lastX: number;
  lastY: number;
  moving: boolean;
  /** что нарисовано в круге стояния; пока не изменилось — не перерисовывается */
  ringKey: string;
}

/**
 * Слой тайников: по спрайту и столбу на тайник мира, один `Graphics` на круги
 * и дуги. Тайников на забег — единицы, и слой не зависит от числа врагов.
 */
export class SecretsRenderer {
  private readonly scene: Phaser.Scene;
  private readonly world: World;
  readonly container: Phaser.GameObjects.Container;
  private readonly rings: Phaser.GameObjects.Graphics;
  private readonly views: SiteView[] = [];
  private readonly reduced = reducedMotion();
  private art: SecretArt | null = null;
  private artScale = 1;

  constructor(scene: Phaser.Scene, world: World, layer: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.world = world;
    const unitScale = world.config.unitScale;
    for (const kind of SECRET_KINDS) {
      ensureBodyTexture(scene, kind, false, unitScale);
      ensureBodyTexture(scene, kind, true, unitScale);
    }
    ensureBeamTexture(scene, unitScale);

    this.container = scene.add.container(0, 0);
    layer.add(this.container);
    this.rings = scene.add.graphics();
    this.container.add(this.rings);
    for (const site of world.secrets.sites) {
      const beam = scene.add.image(site.x, site.y, BEAM_KEY).setOrigin(0.5, 1).setVisible(false);
      const body = scene.add.image(site.x, site.y, BODY_KEY(site.kind, false)).setVisible(false);
      this.container.add(beam);
      this.container.add(body);
      this.views.push({ body, beam, lastX: site.x, lastY: site.y, moving: false, ringKey: "" });
    }
  }

  /** Кадры арта; `null` — режим арта выключен, и тайники снова фигуры. */
  setArt(art: SecretArt | null, scale: number): void {
    this.art = art;
    this.artScale = scale;
    // Текстуры слотов назначаются заново на следующем кадре.
    for (const view of this.views) view.body.setData("look", "");
  }

  /**
   * Поставить слой на своё место в слое мира: над землёй и декором, под
   * героем, врагами и подборами. В режиме арта землю и декор держат первые
   * места, а знак под ногами героя — третье.
   */
  place(layer: Phaser.GameObjects.Container, artOn: boolean): void {
    if (artOn) layer.moveTo(this.container, 3);
    else layer.sendToBack(this.container);
  }

  sync(): void {
    const world = this.world;
    const sites = world.secrets.sites;
    const tick = world.stats.tick;
    const unitScale = world.config.unitScale;
    let redraw = false;
    const ringKeys: string[] = [];

    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];
      const view = this.views[i];
      if (site === undefined || view === undefined) continue;
      if (!site.active) {
        view.body.setVisible(false);
        view.beam.setVisible(false);
        ringKeys.push("");
        continue;
      }
      const dx = site.x - view.lastX;
      const dy = site.y - view.lastY;
      view.moving = dx * dx + dy * dy > 1e-6;
      view.lastX = site.x;
      view.lastY = site.y;

      const state = secretLookState(site, view.moving);
      this.showBody(view, site, state);
      this.showBeam(view, site, state, tick, unitScale);

      // Круг стояния: тонкое кольцо там, где надо стоять, и дуга прогресса поверх него.
      const holdSec = secretHoldSec(world.secretRules, site.kind);
      const progress = holdSec === null || site.used ? 0 : Math.floor(holdProgress(site.holdTicks, holdSec) * ARC_STEPS);
      const showRing = site.kind !== "wisp" && !site.used;
      const key = showRing ? `${String(Math.round(site.x))}:${String(Math.round(site.y))}:${String(progress)}` : "";
      ringKeys.push(key);
      if (view.ringKey !== key) {
        view.ringKey = key;
        redraw = true;
      }
    }
    if (redraw) this.drawRings(ringKeys);
  }

  private showBody(view: SiteView, site: SecretSite, state: SecretLookState): void {
    const frame = this.art?.[site.kind][state] ?? null;
    const look = `${state}|${frame === null ? "shape" : frame.frame}`;
    if (view.body.getData("look") !== look) {
      view.body.setData("look", look);
      if (frame !== null) {
        view.body.setTexture(frame.texture, frame.frame).setScale(this.artScale);
      } else {
        view.body.setTexture(BODY_KEY(site.kind, state === "active")).setScale(1);
      }
    }
    view.body.setPosition(site.x, site.y).setVisible(true);
  }

  /** Столб света — у действующего тайника; огонёк обходится без него. */
  private showBeam(view: SiteView, site: SecretSite, state: SecretLookState, tick: number, unitScale: number): void {
    const lit = state === "active" && site.kind !== "wisp";
    if (!lit) {
      view.beam.setVisible(false);
      return;
    }
    const pulse = this.reduced ? 0 : (triangle(tick % BEAM_PERIOD_TICKS, BEAM_PERIOD_TICKS) - 0.5) * 2 * BEAM_PULSE;
    view.beam.setPosition(site.x, site.y - SECRET_BODY_RADIUS_UNITS * unitScale * 0.3).setTint(SECRET_LOOKS[site.kind].color).setAlpha(BEAM_ALPHA + pulse).setVisible(true);
  }

  private drawRings(keys: readonly string[]): void {
    const world = this.world;
    const unitScale = world.config.unitScale;
    const g = this.rings;
    g.clear();
    keys.forEach((key, i) => {
      const site = world.secrets.sites[i];
      if (key === "" || site === undefined) return;
      const radius = radiusOf(world.secretRules, site.kind) * unitScale;
      const color = SECRET_LOOKS[site.kind].color;
      g.lineStyle(Math.max(1, unitScale), color, RING_ALPHA);
      g.strokeCircle(site.x, site.y, radius);
      const holdSec = secretHoldSec(world.secretRules, site.kind);
      if (holdSec === null) return;
      const progress = holdProgress(site.holdTicks, holdSec);
      if (progress <= 0) return;
      g.lineStyle(ARC_WIDTH_UNITS * unitScale, color, ARC_ALPHA);
      g.beginPath();
      g.arc(site.x, site.y, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2, false);
      g.strokePath();
    });
  }
}
