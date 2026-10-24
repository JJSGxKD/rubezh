import type Phaser from "phaser";

/**
 * Земля и декор чернового арта (design/art/environment.md): нейтральная
 * плитка с окраской по вершинам и декор кучками по чанкам. Только в режиме
 * чернового арта разработчика.
 *
 * Цвет зоны и волна светлоты считаются в углах клеток земли и
 * интерполируются видеокартой: пятна поверх земли стоили втрое больше
 * заливки (environment.md §4). Раскладка — из хэша координат, а не из
 * `world.rng`: рендер не сдвигает забег и golden-прогоны.
 */

/** Ключи текстур: плитка земли и атлас декора — грузит ArtAtlas. */
export const ART_GROUND_KEY = "art-ground";
export const ART_ENV_KEY = "art-env";

/** Сторона клетки земли в игровых единицах: одна плитка 512 px. */
const GROUND_CELL_UNITS = 256;
/** Сторона чанка декора в игровых единицах. */
const CHUNK_UNITS = 384;
/** Светлота основы нейтральной плитки — тинт делится на неё. */
const NEUTRAL_BASE = 0xdc / 0xff;
/** Пикселей атласа декора на игровую единицу — `PPU` сборки. */
const ENV_PPU = 2.5;
/** Зерно раскладки: одна и та же карта у всех, вернулся — увидел то же. */
const SEED = 7;

type Zone = "meadow" | "graveyard" | "mire";

const ZONE_COLORS: Record<Zone, number> = { meadow: 0x33506a, graveyard: 0x434660, mire: 0x2b5656 };

/** Декор зоны: вид, вариантов, штук на чанк. Цвета ролей в декоре не бывает. */
const DECOR: Record<Zone, readonly (readonly [string, number, number])[]> = {
  meadow: [["grass", 3, 9], ["stone", 3, 3], ["mushrooms", 2, 2], ["stump", 1, 1]],
  graveyard: [["cross", 2, 4], ["grave", 2, 3], ["stone", 3, 2], ["bones", 2, 2]],
  mire: [["reeds", 2, 6], ["puddle", 2, 2], ["grass", 3, 4], ["mushrooms", 2, 1], ["bones", 2, 1]],
};

/** Хэш координат в [0, 1). Рендер: на исход забега не влияет. */
export function hash01(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647 + SEED * 1013904223) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Сглаженный шум по сетке крупных ячеек. */
export function valueNoise(x: number, y: number, cell: number, salt: number): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const fx = x / cell - gx;
  const fy = y / cell - gy;
  const s = (t: number): number => t * t * (3 - 2 * t);
  const a = hash01(gx, gy, salt);
  const b = hash01(gx + 1, gy, salt);
  const c = hash01(gx, gy + 1, salt);
  const d = hash01(gx + 1, gy + 1, salt);
  return a + (b - a) * s(fx) + (c - a) * s(fy) + (a - b - c + d) * s(fx) * s(fy);
}

/** Зона в точке (игровые единицы) — по ней выбирается декор. */
export function zoneAt(x: number, y: number): Zone {
  const n = valueNoise(x, y, CHUNK_UNITS * 5, 11);
  return n < 0.36 ? "graveyard" : n > 0.66 ? "mire" : "meadow";
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Тинт угла клетки земли: смесь зон и волна светлоты ±8 %. */
export function groundTint(x: number, y: number): number {
  const n = valueNoise(x, y, CHUNK_UNITS * 5, 11);
  const g = smooth(0.42, 0.3, n);
  const m = smooth(0.6, 0.72, n);
  const w = 1 - g - m;
  const light = 1 + (valueNoise(x, y, 700, 23) - 0.5) * 0.16 + (valueNoise(x, y, 230, 29) - 0.5) * 0.06;
  const channel = (shift: number): number => {
    const v = ((ZONE_COLORS.meadow >> shift) & 255) * w + ((ZONE_COLORS.graveyard >> shift) & 255) * g + ((ZONE_COLORS.mire >> shift) & 255) * m;
    return Math.min(255, Math.round((v * light) / NEUTRAL_BASE));
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

export class ArtGround {
  private readonly scene: Phaser.Scene;
  private readonly unitScale: number;
  private readonly groundLayer: Phaser.GameObjects.Container;
  private readonly decorLayer: Phaser.GameObjects.Container;
  private readonly cells = new Map<number, Phaser.GameObjects.Image>();
  private readonly cellPool: Phaser.GameObjects.Image[] = [];
  private readonly chunks = new Map<number, Phaser.GameObjects.Image[]>();
  private readonly decorPool: Phaser.GameObjects.Image[] = [];
  private visible = false;

  /** Земля и декор — первыми детьми слоя мира: под всем остальным. */
  constructor(scene: Phaser.Scene, layer: Phaser.GameObjects.Container, unitScale: number) {
    this.scene = scene;
    this.unitScale = unitScale;
    this.groundLayer = scene.add.container(0, 0);
    this.decorLayer = scene.add.container(0, 0);
    layer.addAt(this.groundLayer, 0);
    layer.addAt(this.decorLayer, 1);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.groundLayer.setVisible(visible);
    this.decorLayer.setVisible(visible);
    if (!visible) this.releaseAll();
  }

  /** Камера в пикселях мира: центр и половины видимой области. */
  update(centerX: number, centerY: number, halfWidth: number, halfHeight: number): void {
    if (!this.visible) return;
    const unit = this.unitScale;
    this.syncCells(centerX / unit, centerY / unit, halfWidth / unit, halfHeight / unit);
    this.syncChunks(centerX / unit, centerY / unit, halfWidth / unit, halfHeight / unit);
  }

  private syncCells(cx: number, cy: number, hw: number, hh: number): void {
    const x0 = Math.floor((cx - hw) / GROUND_CELL_UNITS);
    const x1 = Math.floor((cx + hw) / GROUND_CELL_UNITS);
    const y0 = Math.floor((cy - hh) / GROUND_CELL_UNITS);
    const y1 = Math.floor((cy + hh) / GROUND_CELL_UNITS);
    for (const [key, image] of this.cells) {
      const gx = Math.round(key / 100003);
      const gy = key - gx * 100003;
      if (gx < x0 || gx > x1 || gy < y0 || gy > y1) {
        image.setVisible(false);
        this.cellPool.push(image);
        this.cells.delete(key);
      }
    }
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = gx * 100003 + gy;
        if (!this.cells.has(key)) this.cells.set(key, this.cell(gx, gy));
      }
    }
  }

  private cell(gx: number, gy: number): Phaser.GameObjects.Image {
    const image = this.cellPool.pop() ?? this.add(this.groundLayer, ART_GROUND_KEY).setOrigin(0, 0);
    const size = GROUND_CELL_UNITS * this.unitScale;
    image.setVisible(true).setPosition(gx * size, gy * size).setScale(size / image.width);
    const corner = (x: number, y: number): number => groundTint(x * GROUND_CELL_UNITS, y * GROUND_CELL_UNITS);
    image.setTint(corner(gx, gy), corner(gx + 1, gy), corner(gx, gy + 1), corner(gx + 1, gy + 1));
    return image;
  }

  private syncChunks(cx: number, cy: number, hw: number, hh: number): void {
    const x0 = Math.floor((cx - hw - CHUNK_UNITS) / CHUNK_UNITS);
    const x1 = Math.floor((cx + hw + CHUNK_UNITS) / CHUNK_UNITS);
    const y0 = Math.floor((cy - hh - CHUNK_UNITS) / CHUNK_UNITS);
    const y1 = Math.floor((cy + hh + CHUNK_UNITS) / CHUNK_UNITS);
    for (const [key, items] of this.chunks) {
      const gx = Math.round(key / 100003);
      const gy = key - gx * 100003;
      if (gx < x0 || gx > x1 || gy < y0 || gy > y1) {
        for (const image of items) {
          image.setVisible(false);
          this.decorPool.push(image);
        }
        this.chunks.delete(key);
      }
    }
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = gx * 100003 + gy;
        if (!this.chunks.has(key)) this.chunks.set(key, this.chunk(gx, gy));
      }
    }
  }

  /**
   * Декор чанка кучками: равномерная россыпь читается как узор и выдаёт
   * повтор раньше плитки. Ориентир — примерно в одном чанке из двенадцати.
   */
  private chunk(gx: number, gy: number): Phaser.GameObjects.Image[] {
    let n = 0;
    const r = (): number => hash01(gx, gy, 5 * 31 + n++);
    const zone = zoneAt((gx + 0.5) * CHUNK_UNITS, (gy + 0.5) * CHUNK_UNITS);
    const unit = this.unitScale;
    const items: Phaser.GameObjects.Image[] = [];
    const place = (frame: string, x: number, y: number, scale: number, flip: boolean): void => {
      const image = this.decorPool.pop() ?? this.add(this.decorLayer, ART_ENV_KEY, frame);
      image.setVisible(true).setFrame(frame).setPosition(x * unit, y * unit).setScale((scale * unit) / ENV_PPU).setFlipX(flip);
      items.push(image);
    };
    for (const [id, variants, count] of DECOR[zone]) {
      for (let k = 0; k < count; k++) {
        const x = (gx + r()) * CHUNK_UNITS + (r() - 0.5) * 60;
        const y = (gy + r()) * CHUNK_UNITS + (r() - 0.5) * 60;
        place(`decor/${id}${String(Math.floor(r() * variants))}`, x, y, 0.85 + r() * 0.3, r() < 0.5);
      }
    }
    if (r() < 0.085) {
      const id = zone === "mire" || r() < 0.5 ? "landmark_pillar" : "landmark_well";
      place(`decor/${id}0`, (gx + 0.3 + r() * 0.4) * CHUNK_UNITS, (gy + 0.3 + r() * 0.4) * CHUNK_UNITS, 1, false);
    }
    return items;
  }

  private add(layer: Phaser.GameObjects.Container, key: string, frame?: string): Phaser.GameObjects.Image {
    const image = this.scene.add.image(0, 0, key, frame);
    layer.add(image);
    return image;
  }

  private releaseAll(): void {
    for (const image of this.cells.values()) {
      image.setVisible(false);
      this.cellPool.push(image);
    }
    this.cells.clear();
    for (const items of this.chunks.values()) {
      for (const image of items) {
        image.setVisible(false);
        this.decorPool.push(image);
      }
    }
    this.chunks.clear();
  }
}
