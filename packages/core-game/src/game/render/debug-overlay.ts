import type Phaser from "phaser";
import type { RunDevVisuals } from "../../run-api";
import type { World } from "../sim/world";
import { DEBUG_COLORS } from "./looks";
import { lerp } from "./textures";

/**
 * Отладочная отрисовка режима разработчика: хитбоксы, радиусы, кольца спавна,
 * границы и сетка столкновений — поверх мира, в его координатах.
 *
 * Здесь Graphics, а не текстуры: это не путь игрока, а инструмент, и цена в
 * отдельный вызов отрисовки на круг приемлема. Объект создаётся по первому
 * включению — у обычного забега его нет вовсе.
 */
export class DebugOverlay {
  private readonly graphics: Phaser.GameObjects.Graphics;

  constructor(
    scene: Phaser.Scene,
    private readonly world: World,
    layer: Phaser.GameObjects.Container,
  ) {
    this.graphics = scene.add.graphics().setDepth(20);
    layer.add(this.graphics);
  }

  draw(visuals: RunDevVisuals, t: number, zoom: number): void {
    const g = this.graphics;
    g.clear();
    const world = this.world;
    const px = lerp(world.player.prevX, world.player.x, t);
    const py = lerp(world.player.prevY, world.player.y, t);
    // Толщина линии — в экранных пикселях: при отдалении камеры контуры не
    // должны становиться волосками.
    const line = Math.max(1, world.config.unitScale) / Math.max(0.05, zoom);

    if (visuals.grid) this.drawGrid(line);
    if (visuals.spawnRings) {
      g.lineStyle(line * 1.5, DEBUG_COLORS.spawnRing, 0.6).strokeCircle(px, py, world.config.view.spawnRadius);
      g.lineStyle(line * 1.5, DEBUG_COLORS.retentionRing, 0.6).strokeCircle(px, py, world.config.view.retentionRadius);
    }
    if (visuals.bounds) this.drawBounds(line);
    if (visuals.pickupRadius) {
      g.lineStyle(line, DEBUG_COLORS.pickupRadius, 0.8).strokeCircle(px, py, world.playerStats.pickupRadius);
    }
    if (visuals.weaponRadii) this.drawWeaponRadii(px, py, line);
    if (visuals.hitboxes) this.drawHitboxes(px, py, t, line);
  }

  setVisible(visible: boolean): void {
    if (!visible) this.graphics.clear();
    this.graphics.setVisible(visible);
  }

  private drawHitboxes(px: number, py: number, t: number, line: number): void {
    const g = this.graphics;
    const world = this.world;
    const enemies = world.enemies;
    for (let i = 0; i < enemies.count; i++) {
      if (enemies.alive[i] === 0) continue;
      const type = world.enemyTypes[enemies.type[i]];
      g.lineStyle(line, type.elite ? DEBUG_COLORS.hitboxElite : DEBUG_COLORS.hitboxEnemy, 0.85);
      g.strokeCircle(lerp(enemies.prevX[i], enemies.x[i], t), lerp(enemies.prevY[i], enemies.y[i], t), type.radius);
    }
    const projectiles = world.projectiles;
    const projectileRadius = world.config.player.projectileRadius;
    g.lineStyle(line, DEBUG_COLORS.hitboxProjectile, 0.85);
    for (let p = 0; p < projectiles.count; p++) {
      if (projectiles.alive[p] === 0) continue;
      g.strokeCircle(lerp(projectiles.prevX[p], projectiles.x[p], t), lerp(projectiles.prevY[p], projectiles.y[p], t), projectileRadius);
    }
    g.lineStyle(line * 1.5, DEBUG_COLORS.hitboxPlayer, 1).strokeCircle(px, py, world.config.player.radius);
  }

  private drawWeaponRadii(px: number, py: number, line: number): void {
    const g = this.graphics;
    const world = this.world;
    const areaMul = world.playerStats.areaMul;
    let drewRange = false;
    for (const slot of world.loadout.weapons) {
      const type = world.weaponTypes[slot.typeIndex];
      const level = type.levels[Math.min(slot.level, type.levels.length) - 1];
      if (level === undefined) continue;
      // Радиус с пассивкой площади — ровно тот, которым бьёт `updateWeapons`:
      // у ауры это зона урона, у оберегов — кольцо, по которому они ходят.
      if (type.behavior === "aura" || type.behavior === "orbit") {
        g.lineStyle(line * 1.5, DEBUG_COLORS.weaponRadius, 0.8).strokeCircle(px, py, level.areaRadius * areaMul);
      }
      if (type.behavior === "projectile_nearest" && !drewRange) {
        // Дальность поиска цели общая на все снаряды в ближайшего.
        g.lineStyle(line, DEBUG_COLORS.weaponRange, 0.5).strokeCircle(px, py, world.config.player.attackRangePx);
        drewRange = true;
      }
    }
  }

  private drawBounds(line: number): void {
    const bounds = this.world.config.bounds;
    const g = this.graphics;
    g.lineStyle(line * 2, DEBUG_COLORS.bounds, 0.9);
    const halfW = bounds.halfWidth;
    const halfH = bounds.halfHeight;
    const reach = this.world.config.view.retentionRadius * 2;
    const px = this.world.player.x;
    const py = this.world.player.y;
    // Бесконечная ось рисуется отрезком вокруг игрока: у линии в бесконечность
    // нет координат, а у стены — есть.
    if (Number.isFinite(halfW)) {
      g.lineBetween(-halfW, clampReach(py - reach, halfH), -halfW, clampReach(py + reach, halfH));
      g.lineBetween(halfW, clampReach(py - reach, halfH), halfW, clampReach(py + reach, halfH));
    }
    if (Number.isFinite(halfH)) {
      g.lineBetween(clampReach(px - reach, halfW), -halfH, clampReach(px + reach, halfW), -halfH);
      g.lineBetween(clampReach(px - reach, halfW), halfH, clampReach(px + reach, halfW), halfH);
    }
  }

  private drawGrid(line: number): void {
    const grid = this.world.enemyGrid;
    const g = this.graphics;
    const size = grid.cell * grid.columns;
    g.lineStyle(line, DEBUG_COLORS.grid, 0.18);
    for (let k = 0; k <= grid.columns; k++) {
      const offset = k * grid.cell;
      g.lineBetween(grid.left + offset, grid.top, grid.left + offset, grid.top + size);
      g.lineBetween(grid.left, grid.top + offset, grid.left + size, grid.top + offset);
    }
  }
}

function clampReach(value: number, half: number): number {
  return Number.isFinite(half) ? Math.max(-half, Math.min(half, value)) : value;
}
