import type Phaser from "phaser";
import type { ArtFrame } from "./art-atlas";
import { STATUS_TONE } from "./status-tones";

/**
 * Знаки состояний над врагами-спрайтами (design/art/direction-v2.md §4.5).
 *
 * Заливка цветом стихии рассчитана на врага-фигуру: у спрайта она стирает
 * рисунок, и толпа под «Очагом» мигала бы сплошными силуэтами. В режиме арта
 * над головой горящего — язычок пламени, над шокированным — молния, над
 * отравленным — капля, над остывшим — снежинка. Заморозка остаётся заливкой:
 * враг стоит ледяной статуей, и это читается издалека. Рендер, на исход
 * забега не влияет.
 */

/** Кадры знака по тону состояния (`STATUS_TONE`). */
export const STATUS_MARK_FRAMES: Readonly<Record<number, readonly string[]>> = {
  [STATUS_TONE.frozen]: ["fx/status_frozen0"],
  [STATUS_TONE.shock]: ["fx/status_shock0", "fx/status_shock1"],
  [STATUS_TONE.burn]: ["fx/status_burn0", "fx/status_burn1"],
  [STATUS_TONE.poison]: ["fx/status_poison0", "fx/status_poison1"],
  [STATUS_TONE.chill]: ["fx/status_chill0"],
};

/** Насколько выше центра врага стоит знак, в его радиусах: над головой, а не на лице. */
export const MARK_RISE = 1.6;

/**
 * То же у героя: его кадр выше ячейки врага (2,6 радиуса против 2,2), и знак
 * на высоте врага сел бы ему на капюшон.
 */
export const HERO_MARK_RISE = 3;

/** Тиков на кадр знака: пламя дрожит, разряд щёлкает — живо, но не стробоскоп. */
export const MARK_FRAME_TICKS = 8;

/** Сдвиг фазы по слоту: толпа горит вразнобой, а не дрожит строем. */
const MARK_SLOT_SHIFT = 5;

/** Номер кадра знака из `count` кадров. */
export function markFrame(count: number, tick: number, slot: number): number {
  if (count <= 1) return 0;
  return Math.floor((tick + slot * MARK_SLOT_SHIFT) / MARK_FRAME_TICKS) % count;
}

/** Остаётся ли у спрайта заливка тоном: только у заморозки — ледяная статуя. */
export function keepsFill(status: number): boolean {
  return status === STATUS_TONE.frozen;
}

/** Кадры атласа по тону состояния; пустой список — у тона знака нет. */
export type StatusMarkArt = readonly (readonly ArtFrame[])[];

/** Пул знаков: растёт до числа врагов в состояниях, лишние прячутся в `end`. */
export class StatusMarks {
  private readonly scene: Phaser.Scene;
  private readonly layer: Phaser.GameObjects.Container;
  private readonly sprites: Phaser.GameObjects.Image[] = [];
  private used = 0;
  private art: StatusMarkArt | null = null;
  private scale = 1;

  constructor(scene: Phaser.Scene, layer: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.layer = layer;
  }

  /** Кадры и масштаб атласа; `null` — режим арта выключен, знаков нет. */
  setArt(art: StatusMarkArt | null, scale: number): void {
    this.art = art;
    this.scale = scale;
    for (const sprite of this.sprites) sprite.setScale(scale);
    if (art === null) {
      this.begin();
      this.end();
    }
  }

  begin(): void {
    this.used = 0;
  }

  /** Знак в точке `x`, `y` мира; `slot` сдвигает фазу дрожания. */
  place(slot: number, x: number, y: number, status: number, tick: number): void {
    const frames = this.art?.[status];
    if (frames === undefined || frames.length === 0) return;
    const frame = frames[markFrame(frames.length, tick, slot)];
    if (frame === undefined) return;
    const sprite = this.sprites[this.used] ?? this.create();
    this.used++;
    if (sprite.texture.key !== frame.texture || sprite.frame.name !== frame.frame) sprite.setTexture(frame.texture, frame.frame);
    sprite.setPosition(x, y);
    if (!sprite.visible) sprite.setVisible(true);
  }

  end(): void {
    for (let i = this.used; i < this.sprites.length; i++) {
      const sprite = this.sprites[i];
      if (sprite?.visible === true) sprite.setVisible(false);
    }
  }

  private create(): Phaser.GameObjects.Image {
    const sprite = this.scene.add.image(0, 0, "__DEFAULT").setScale(this.scale).setVisible(false);
    this.layer.add(sprite);
    this.sprites.push(sprite);
    return sprite;
  }
}
