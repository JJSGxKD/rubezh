import Phaser from "phaser";
import type { EnemyPattern } from "@bh/shared-types";
import type { RunDevVisuals, RunGraphicsOptions } from "../../run-api";
import type { World } from "../sim/world";
import { SIM_EVENT } from "../sim/events";
import { NEVER_HIT } from "../sim/pools";
import { CASTER_PHASE, DASH_PHASE, EXPLODER_PHASE, isElite } from "../patterns";
import { ORBITER_RADIUS, orbiterCount, orbiterPosition, type OrbiterPoint } from "../weapons";
import { CombatFeedback } from "./combat-feedback";
import { DebugOverlay } from "./debug-overlay";
import { PickupRenderer } from "./pickups";
import { ENEMY_LOOKS, enemyColor, stageColor, stageCore, WORLD_COLORS } from "./looks";
import { PlayerRings } from "./player-rings";
import { STATUS_TONE_COLORS, statusTone } from "./status-tones";
import { AIM_TELEGRAPH_SEC, Telegraphs } from "./telegraphs";
import { WeaponEffects } from "./weapon-effects";
import { ensureShapeTexture, lerp } from "./textures";
import { invulnerableAlpha } from "./invulnerable";

const orbiterScratch: OrbiterPoint = { x: 0, y: 0 };

/**
 * Рендер состояния симуляции. Отделён от неё полностью: симуляция не знает,
 * что её кто-то рисует, и потому запускается headless
 * (docs/17-testing-strategy.md §3.0).
 *
 * Здесь — игрок, враги, снаряды, обереги и взрывы. Предметы на земле,
 * телеграфы угроз и обратная связь боя живут в своих модулях рядом: у каждого
 * свои пулы спрайтов и своя анимация, а общий у них только слой мира.
 *
 * Спрайты переиспользуются и никогда не уничтожаются: создание и уничтожение
 * объектов Phaser в кадре — источник пауз сборщика мусора, а именно они портят
 * p99 времени кадра на бюджетном Android.
 *
 * Создаются они при этом по мере надобности, а не сразу по ёмкости пулов.
 * Phaser обходит весь список отображения каждый кадр, включая невидимые
 * объекты; в агрессивном прогоне ёмкость — тысячи, и предсоздание отдало бы
 * заметную часть кадра на обход спрайтов, которых на экране нет.
 *
 * Формы генерируются в текстуры один раз. Рисовать врагов через Graphics
 * каждый кадр нельзя: это отдельный вызов отрисовки на врага вместо одного
 * батча на всех.
 */
export class WorldRenderer {
  private readonly scene: Phaser.Scene;
  private readonly world: World;
  /**
   * Слой мира. Камера забега — это трансформация слоя, а не камера Phaser:
   * HUD и экраны живут в том же дереве сцены и обязаны остаться в экранных
   * координатах, не масштабируясь вместе с миром. Вторая камера Phaser
   * потребовала бы вести список игнорирования для каждого создаваемого на ходу
   * спрайта — легко забыть, и промах виден только на устройстве.
   */
  private readonly layer: Phaser.GameObjects.Container;
  /** повторяющийся фон: единственное, что даёт почувствовать движение мира */
  private readonly ground: Phaser.GameObjects.TileSprite;
  private readonly enemySprites: Phaser.GameObjects.Image[] = [];
  /** индекс текстуры врага: тип и ступень вместе, см. конструктор */
  private readonly enemySpriteType: Int16Array;
  private readonly stageCount: number;
  /** последний применённый вид спрайта — чтобы не дёргать Phaser каждый кадр */
  private readonly enemySpriteLook: Uint8Array;
  private readonly projectileSprites: Phaser.GameObjects.Image[] = [];
  private readonly player: Phaser.GameObjects.Image;
  /** ключи текстур по паре «тип и ступень»: индекс = тип × число ступеней + ступень */
  private readonly textureKeyByType: string[] = [];
  private readonly orbiterSprites: Phaser.GameObjects.Image[] = [];
  private readonly blasts: Phaser.GameObjects.Image[] = [];
  private readonly pickups: PickupRenderer;
  private readonly telegraphs: Telegraphs;
  /** граница «Очага» и молнии «Грозы» */
  private readonly weaponEffects: WeaponEffects;
  /** числа урона и вспышки гибели */
  private readonly feedback: CombatFeedback;
  /** тик последнего попадания по игроку — для вспышки персонажа */
  private playerHitTick = NEVER_HIT;
  /** настройки графики игрока; `null` — рисуем всё */
  private graphics: RunGraphicsOptions | null = null;
  /** кольца здоровья и опыта вокруг персонажа */
  private readonly rings: PlayerRings;
  /** тик последнего лечения — персонаж коротко вспыхивает зелёным */
  private playerHealTick = NEVER_HIT;
  private readonly blastStartTick: Int32Array = new Int32Array(MAX_BLASTS).fill(-1);
  private readonly blastRadius: Float32Array = new Float32Array(MAX_BLASTS);
  private readonly blastKind: Uint8Array = new Uint8Array(MAX_BLASTS);
  private eventsRead = 0;
  private nextBlast = 0;
  /** режим разработчика; `null` — обычный забег, всё как у игрока */
  private visuals: RunDevVisuals | null = null;
  private debug: DebugOverlay | null = null;
  private zoom = 1;

  constructor(scene: Phaser.Scene, world: World) {
    this.scene = scene;
    this.world = world;
    this.enemySpriteType = new Int16Array(world.config.maxEnemies).fill(-1);
    this.enemySpriteLook = new Uint8Array(world.config.maxEnemies);

    const colorByType = world.enemyTypes.map((type) => enemyColor(type.pattern, isElite(type)));
    // Текстура на пару «тип и ступень»: ступень меняет цвет тела и садит в
    // середину ядро, поэтому одной текстуры на тип не хватает.
    this.stageCount = world.stages.length;
    world.enemyTypes.forEach((type, index) => {
      for (let stage = 0; stage < this.stageCount; stage++) {
        const key = `bh-enemy-${type.id}-s${String(stage)}`;
        // Элита крупнее и светлее: одинаковые на глаз танк и элитный танк
        // читаются как дефект, а не как контрольная точка сложности.
        ensureShapeTexture(
          scene,
          key,
          type.radius,
          stageColor(colorByType[index], stage),
          ENEMY_LOOKS[type.pattern].shape,
          stageCore(stage),
        );
        this.textureKeyByType.push(key);
      }
    });

    const scale = world.config.unitScale;
    this.ensureGroundTexture(scale);
    this.ground = scene.add
      .tileSprite(0, 0, scene.scale.width, scene.scale.height, "bh-ground")
      .setOrigin(0, 0)
      .setDepth(-10);
    this.layer = scene.add.container(0, 0).setDepth(0);

    ensureShapeTexture(scene, "bh-player", world.config.player.radius, WORLD_COLORS.player, "player");
    ensureShapeTexture(scene, "bh-projectile", world.config.player.projectileRadius, WORLD_COLORS.projectile, "circle");
    // Снаряд врага крупнее и другой формы: он должен читаться как летящая
    // угроза, а не как мелкий враг, на которого можно бежать.
    ensureShapeTexture(scene, "bh-projectile-enemy", world.config.player.projectileRadius * 1.35, WORLD_COLORS.enemyProjectile, "bolt");
    ensureShapeTexture(scene, "bh-blast", BLAST_TEXTURE_UNITS * scale, WORLD_COLORS.blast, "ring");
    ensureShapeTexture(scene, "bh-heal", BLAST_TEXTURE_UNITS * scale, WORLD_COLORS.heal, "ring");
    ensureShapeTexture(scene, "bh-magnet", WAVE_TEXTURE_UNITS * scale, WORLD_COLORS.magnetWave, "wave");
    ensureShapeTexture(scene, "bh-dynamite", WAVE_TEXTURE_UNITS * scale, WORLD_COLORS.dynamiteWave, "wave");
    ensureShapeTexture(scene, "bh-orbiter", ORBITER_RADIUS * scale, WORLD_COLORS.orbiter, "circle");

    this.telegraphs = new Telegraphs(scene, world, this.layer);
    this.weaponEffects = new WeaponEffects(scene, world, this.layer);
    this.pickups = new PickupRenderer(scene, world, this.layer);
    this.feedback = new CombatFeedback(scene, world, this.layer, colorByType);

    this.player = scene.add.image(world.player.x, world.player.y, "bh-player").setDepth(2);
    this.layer.add(this.player);
    this.rings = new PlayerRings(scene, world, this.layer);
    this.eventsRead = world.events.written;
  }

  /**
   * Перенести камеру забега на слой мира и на фон.
   *
   * Мир бесконечен, поэтому фон — повторяющаяся текстура, сдвинутая на
   * положение камеры: без него на пустом участке карты движение не видно
   * вовсе — персонаж и враги висят в чёрном, и игрок не понимает, бежит он
   * или стоит (docs/26-stage2-plan.md, WP4.1).
   */
  applyCamera(x: number, y: number, zoom: number): void {
    const width = this.scene.scale.width;
    const height = this.scene.scale.height;
    this.zoom = zoom;

    this.layer.setScale(zoom);
    this.layer.setPosition(width / 2 - x * zoom, height / 2 - y * zoom);

    this.ground.setSize(width, height);
    this.ground.setTileScale(zoom, zoom);
    this.ground.setTilePosition(x - width / (2 * zoom), y - height / (2 * zoom));
  }

  /**
   * Перенести состояние мира на спрайты. Вызывается раз в кадр, не раз в тик.
   *
   * `alpha` — доля пройденного времени до следующего шага симуляции.
   * Симуляция идёт фиксированными шагами по 60 Гц, а кадры приходят когда
   * придут; без интерполяции между предыдущим и текущим положением картинка
   * дёргается каждый раз, когда кадр не совпал с шагом.
   */
  sync(alpha: number): void {
    const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    this.syncEnemies(t);
    this.syncProjectiles(t);
    this.pickups.sync(t);
    this.syncOrbiters();
    this.syncBlasts();
    this.weaponEffects.sync(t);
    this.feedback.sync();

    this.player.setPosition(
      lerp(this.world.player.prevX, this.world.player.x, t),
      lerp(this.world.player.prevY, this.world.player.y, t),
    );
    this.player.setVisible(this.world.player.alive);
    this.player.setAlpha(invulnerableAlpha(this.world.player.invulnerableTicks));
    this.applyPlayerFlash();
    this.rings.draw(this.player.x, this.player.y);

    if (this.debug !== null && this.visuals !== null) this.debug.draw(this.visuals, t, this.zoom);
  }

  /**
   * Настройки графики игрока. Режим разработчика поверх них — свои
   * выключатели: он смотрит на то, что настроил, а не на то, что у игрока.
   */
  setGraphics(graphics: RunGraphicsOptions | null): void {
    this.graphics = graphics;
    this.applyEffectSwitches();
  }

  /**
   * Отладочная отрисовка и выключатели эффектов режима разработчика. Оверлей
   * создаётся по первому включению: обычный забег его не держит.
   */
  setDevVisuals(visuals: RunDevVisuals | null): void {
    this.visuals = visuals;
    this.applyEffectSwitches();
    const wantsDebug =
      visuals !== null &&
      (visuals.hitboxes || visuals.pickupRadius || visuals.weaponRadii || visuals.spawnRings || visuals.bounds || visuals.grid);
    if (wantsDebug && this.debug === null) this.debug = new DebugOverlay(this.scene, this.world, this.layer);
    this.debug?.setVisible(wantsDebug);
  }

  private applyEffectSwitches(): void {
    this.feedback.enabled = this.visuals?.damageNumbers ?? this.graphics?.damageNumbers ?? true;
    this.weaponEffects.enabled = this.visuals?.effects ?? this.graphics?.weaponEffects ?? true;
  }

  /**
   * Вспышка персонажа: красная — при получении урона, зелёная — при лечении.
   *
   * Полоска здоровья в углу — не обратная связь: игрок смотрит на персонажа.
   * Без вспышки урон выглядит так, будто здоровье убывает само по себе, и
   * непонятно, кто и когда попал.
   */
  private applyPlayerFlash(): void {
    const tick = this.world.stats.tick;
    const hitAge = tick - this.playerHitTick;
    const healAge = tick - this.playerHealTick;

    // Попадание важнее лечения: если было и то и другое, игрок должен видеть урон.
    if (hitAge < HIT_FLASH_TICKS) {
      this.player.setTintFill(WORLD_COLORS.hurt);
      this.player.setScale(1 + 0.25 * (1 - hitAge / HIT_FLASH_TICKS));
      return;
    }
    if (healAge < HIT_FLASH_TICKS) {
      this.player.setTintFill(WORLD_COLORS.heal);
      this.player.setScale(1 + 0.2 * (1 - healAge / HIT_FLASH_TICKS));
      return;
    }
    this.player.clearTint();
    this.player.setScale(1);
  }

  private syncEnemies(t: number): void {
    const enemies = this.world.enemies;
    const tick = this.world.stats.tick;
    const playerX = lerp(this.world.player.prevX, this.world.player.x, t);
    const playerY = lerp(this.world.player.prevY, this.world.player.y, t);
    const telegraphsOn = this.visuals?.telegraphs ?? this.graphics?.telegraphs ?? true;
    // Тон состояния — эффект оружия: кто выключил эффекты ради тишины на
    // экране, не хочет и мерцания толпы (docs/27-design-system-and-app-shell.md §7.1).
    const statusTones = this.weaponEffects.enabled;
    this.telegraphs.begin();

    for (let i = 0; i < enemies.count; i++) {
      const sprite = this.enemySprite(i);
      if (enemies.alive[i] === 0) {
        if (sprite.visible) sprite.setVisible(false);
        continue;
      }

      const typeIndex = enemies.type[i];
      const texture = typeIndex * this.stageCount + Math.min(enemies.stage[i], this.stageCount - 1);
      if (this.enemySpriteType[i] !== texture) {
        sprite.setTexture(this.textureKeyByType[texture]);
        this.enemySpriteType[i] = texture;
      }

      const type = this.world.enemyTypes[typeIndex];
      // Попадание важнее телеграфа: игрок должен видеть, что снаряд дошёл.
      // Тон состояния — ниже обоих: телеграф предупреждает об ударе, а
      // состояние только подсказывает, что с врагом.
      let look =
        tick - enemies.hitTick[i] < HIT_FLASH_TICKS
          ? LOOK.hit
          : lookFor(type.pattern, enemies.phase[i], tick);
      if (look === LOOK.normal && statusTones) look = LOOK.status + statusTone(enemies, i, tick);
      this.applyLook(sprite, i, look);
      sprite.setVisible(true);

      const x = lerp(enemies.prevX[i], enemies.x[i], t);
      const y = lerp(enemies.prevY[i], enemies.y[i], t);
      sprite.setPosition(x, y);
      // Остриё смотрит туда, куда враг идёт, а на замахе — куда ударит: клин,
      // повёрнутый не в ту сторону, читается как чужой враг. Фигуры без
      // острия разворот не трогает — и сбрасывает его, если слот пула достался
      // им от клина.
      if (ENEMY_LOOKS[type.pattern].shape === "chevron") {
        const aimed = enemies.phase[i] === DASH_PHASE.telegraph || enemies.phase[i] === DASH_PHASE.dash;
        const faceX = aimed ? enemies.dirX[i] : enemies.vx[i];
        const faceY = aimed ? enemies.dirY[i] : enemies.vy[i];
        if (faceX !== 0 || faceY !== 0) sprite.setRotation(Math.atan2(faceY, faceX) + Math.PI / 2);
      } else if (sprite.rotation !== 0) {
        sprite.setRotation(0);
      }

      if (!telegraphsOn) continue;
      if (type.pattern === "exploder" && enemies.phase[i] === EXPLODER_PHASE.fuse) {
        const progress = 1 - enemies.phaseTimer[i] / type.params.fuseSec;
        this.telegraphs.ring(x, y, type.params.blastRadius, progress);
      }
      if (type.pattern === "dash" && enemies.phase[i] === DASH_PHASE.telegraph) {
        const length = type.params.dashSpeed * type.params.dashDurationSec;
        const progress = 1 - enemies.phaseTimer[i] / type.params.telegraphSec;
        this.telegraphs.lane(x, y, enemies.dirX[i], enemies.dirY[i], length, progress);
      }
      if (type.pattern === "caster" && enemies.phase[i] === CASTER_PHASE.windup) {
        // Кольцо вокруг кастера растёт к моменту удара — та же грамматика
        // телеграфа, что у фитиля подрывника: круг заполняется — сейчас будет.
        const progress = 1 - enemies.phaseTimer[i] / type.params.telegraphSec;
        this.telegraphs.ring(x, y, type.params.preferredDistance * 0.35, progress);
      }
      if (type.pattern === "kite_and_shoot" && enemies.attackCooldown[i] < AIM_TELEGRAPH_SEC) {
        const progress = 1 - enemies.attackCooldown[i] / AIM_TELEGRAPH_SEC;
        this.telegraphs.aim(x, y, playerX, playerY, progress);
      }
    }

    this.telegraphs.end();
  }

  private syncProjectiles(t: number): void {
    const projectiles = this.world.projectiles;
    for (let p = 0; p < projectiles.count; p++) {
      const sprite = this.projectileSprite(p);
      if (projectiles.alive[p] === 0) {
        if (sprite.visible) sprite.setVisible(false);
        continue;
      }
      const fromPlayer = projectiles.fromPlayer[p] === 1;
      sprite.setTexture(fromPlayer ? "bh-projectile" : "bh-projectile-enemy");
      sprite.setVisible(true);
      sprite.setPosition(
        lerp(projectiles.prevX[p], projectiles.x[p], t),
        lerp(projectiles.prevY[p], projectiles.y[p], t),
      );
      // Вражеский снаряд вытянут по полёту: видно не только «что-то летит», а
      // куда именно. Своим это не нужно — они и так летят от игрока.
      if (fromPlayer) continue;
      sprite.setRotation(Math.atan2(projectiles.vy[p], projectiles.vx[p]));
      sprite.setScale(1.15, 0.8);
    }
  }

  /**
   * Обереги не живут в пуле снарядов: их положение целиком задаётся
   * состоянием оружия, поэтому рендер спрашивает его у самого оружия.
   */
  private syncOrbiters(): void {
    const world = this.world;
    let drawn = 0;

    for (let slot = 0; slot < world.loadout.weapons.length; slot++) {
      const weapon = world.loadout.weapons[slot];
      const type = world.weaponTypes[weapon.typeIndex];
      if (type.behavior !== "orbit") continue;

      const level = type.levels[Math.min(weapon.level, type.levels.length) - 1];
      const count = orbiterCount(level);
      for (let k = 0; k < count; k++) {
        orbiterPosition(world, slot, level, k, orbiterScratch);
        const sprite = this.orbiterSprite(drawn++);
        sprite.setVisible(true);
        sprite.setPosition(orbiterScratch.x, orbiterScratch.y);
      }
    }

    for (let i = drawn; i < this.orbiterSprites.length; i++) {
      if (this.orbiterSprites[i].visible) this.orbiterSprites[i].setVisible(false);
    }
  }

  /**
   * Вид спрайта меняется только при смене состояния: вызов setAlpha и
   * setScale на каждого врага каждый кадр — лишняя работа на сотнях объектов.
   */
  private applyLook(sprite: Phaser.GameObjects.Image, index: number, look: number): void {
    if (this.enemySpriteLook[index] === look && sprite.visible) return;
    this.enemySpriteLook[index] = look;
    sprite.setAlpha(look === LOOK.dim ? 0.35 : 1);
    sprite.setScale(look === LOOK.hit ? 1.25 : look === LOOK.warning || look === LOOK.dim ? 1.2 : 1);
    // Заливка, а не умножение: белый множитель цвет не меняет вовсе, и
    // телеграф с попаданием читались бы только по размеру спрайта. Заливка
    // перекрашивает спрайт целиком и сохраняет его форму по альфе. Тон
    // состояния — тоже заливка: умножение на синий сделало бы красного врага
    // чёрным, а не замёрзшим.
    if (look === LOOK.warning || look === LOOK.hit) sprite.setTintFill(0xffffff);
    else if (look > LOOK.status) sprite.setTintFill(STATUS_TONE_COLORS[look - LOOK.status] ?? 0xffffff);
    else sprite.clearTint();
  }

  /**
   * Взрывы и лечение — из буфера событий симуляции. Длительность эффекта
   * считается в тиках симуляции, а не в реальном времени: на паузе эффект
   * замирает вместе с миром, и рендеру не нужно знать время кадра.
   */
  private syncBlasts(): void {
    const events = this.world.events;
    const capacity = events.kind.length;
    const first = Math.max(this.eventsRead, events.written - capacity);
    const scale = this.world.config.unitScale;
    const effectsOn = this.visuals?.effects ?? true;

    for (let seq = first; seq < events.written; seq++) {
      const slot = seq % capacity;
      const kind = events.kind[slot];
      if (kind === SIM_EVENT.playerHit) {
        this.playerHitTick = events.tick[slot];
        continue;
      }
      // Вспышка персонажа — обратная связь, а не эффект: она остаётся.
      if (!effectsOn) {
        if (kind === SIM_EVENT.heal) this.playerHealTick = events.tick[slot];
        continue;
      }
      if (kind === SIM_EVENT.heal) {
        // Кольцо лечения расходится от игрока: аптечка сработала.
        this.playerHealTick = events.tick[slot];
        this.startBlast(events.x[slot], events.y[slot], HEAL_RING_UNITS * scale, events.tick[slot], kind);
        continue;
      }
      if (kind === SIM_EVENT.magnet) {
        // Магнит: кольцо расходится от игрока — кристаллы сейчас полетят к нему.
        this.startBlast(events.x[slot], events.y[slot], MAGNET_RING_UNITS * scale, events.tick[slot], kind);
        continue;
      }
      if (kind === SIM_EVENT.dynamite) {
        // Динамит: ударная волна на весь радиус взрыва — видно, докуда выкосило.
        this.startBlast(events.x[slot], events.y[slot], events.radius[slot], events.tick[slot], kind);
        continue;
      }
      if (kind === SIM_EVENT.strike) {
        // Кольцо площади под молнией рисует сама молния — отдельный взрыв
        // поверх неё превращал бы удар в два эффекта.
        this.weaponEffects.strike(events.x[slot], events.y[slot], events.radius[slot], events.tick[slot]);
        continue;
      }
      if (kind !== SIM_EVENT.explosion) continue;
      this.startBlast(events.x[slot], events.y[slot], events.radius[slot], events.tick[slot], kind);
    }
    this.eventsRead = events.written;

    const tick = this.world.stats.tick;
    for (let b = 0; b < this.blasts.length; b++) {
      const sprite = this.blasts[b];
      const age = tick - this.blastStartTick[b];
      const wave = isWave(this.blastKind[b]);
      const lifetime = wave ? WAVE_LIFETIME_TICKS : BLAST_LIFETIME_TICKS;
      if (this.blastStartTick[b] < 0 || age >= lifetime) {
        if (sprite.visible) sprite.setVisible(false);
        continue;
      }
      const progress = age / lifetime;
      const textureRadius = (wave ? WAVE_TEXTURE_UNITS : BLAST_TEXTURE_UNITS) * scale;
      // Волна разбегается от игрока с торможением, обычный взрыв — чуть дорастает.
      const grow = wave ? 0.15 + 0.85 * (1 - (1 - progress) * (1 - progress)) : 0.6 + 0.4 * progress;
      sprite.setScale((this.blastRadius[b] / textureRadius) * grow);
      sprite.setAlpha(1 - progress);
      sprite.setVisible(true);
    }
  }

  private startBlast(x: number, y: number, radius: number, tick: number, kind: number): void {
    const b = this.nextBlast;
    this.nextBlast = (this.nextBlast + 1) % MAX_BLASTS;
    while (this.blasts.length <= b) {
      const sprite = this.scene.add.image(0, 0, "bh-blast").setVisible(false).setDepth(3);
      this.layer.add(sprite);
      this.blasts.push(sprite);
    }
    if (this.blastKind[b] !== kind) {
      this.blasts[b].setTexture(BLAST_TEXTURE_BY_KIND[kind] ?? "bh-blast");
      this.blastKind[b] = kind;
    }
    this.blasts[b].setPosition(x, y);
    this.blastStartTick[b] = tick;
    this.blastRadius[b] = radius;
  }

  private orbiterSprite(index: number): Phaser.GameObjects.Image {
    while (this.orbiterSprites.length <= index) {
      const sprite = this.scene.add.image(0, 0, "bh-orbiter").setVisible(false).setDepth(2);
      this.layer.add(sprite);
      this.orbiterSprites.push(sprite);
    }
    return this.orbiterSprites[index];
  }

  /**
   * Спрайты появляются по мере роста занятой части пула и дальше живут вечно.
   * Верхняя граница — та же ёмкость пула, так что бесконтрольного роста нет.
   */
  private enemySprite(index: number): Phaser.GameObjects.Image {
    while (this.enemySprites.length <= index) {
      this.enemySprites.push(this.createHiddenSprite(this.textureKeyByType[0] ?? "bh-player"));
    }
    return this.enemySprites[index];
  }

  private projectileSprite(index: number): Phaser.GameObjects.Image {
    while (this.projectileSprites.length <= index) {
      this.projectileSprites.push(this.createHiddenSprite("bh-projectile"));
    }
    return this.projectileSprites[index];
  }

  /** Все объекты мира живут в слое: камера — это его трансформация. */
  private createHiddenSprite(key: string): Phaser.GameObjects.Image {
    const sprite = this.scene.add.image(0, 0, key).setVisible(false).setDepth(1);
    this.layer.add(sprite);
    return sprite;
  }

  /**
   * Плитка фона. Размер в игровых единицах, а не в пикселях экрана: сетка
   * обязана быть одинаковой на любом устройстве, иначе на телефоне с высокой
   * плотностью она превращается в мелкую рябь.
   */
  private ensureGroundTexture(scale: number): void {
    const key = "bh-ground";
    if (this.scene.textures.exists(key)) return;

    const size = Math.max(2, Math.round(GROUND_TILE_UNITS * scale));
    const graphics = this.scene.make.graphics({ x: 0, y: 0 }, false);
    graphics.fillStyle(WORLD_COLORS.ground, 1);
    graphics.fillRect(0, 0, size, size);
    graphics.fillStyle(WORLD_COLORS.groundLine, 1);
    graphics.fillRect(0, 0, size, Math.max(1, Math.round(scale)));
    graphics.fillRect(0, 0, Math.max(1, Math.round(scale)), size);
    graphics.generateTexture(key, size, size);
    graphics.destroy();
  }
}


/** Сколько взрывов показывается одновременно; дальше перезаписываются старые. */
const MAX_BLASTS = 24;
/** Сторона плитки фона в игровых единицах. */
const GROUND_TILE_UNITS = 64;
const BLAST_LIFETIME_TICKS = 18;
const BLAST_TEXTURE_UNITS = 32;
const BLAST_TEXTURE_BY_KIND: Partial<Record<number, string>> = {
  [SIM_EVENT.explosion]: "bh-blast",
  [SIM_EVENT.heal]: "bh-heal",
  [SIM_EVENT.magnet]: "bh-magnet",
  [SIM_EVENT.dynamite]: "bh-dynamite",
};
/** Радиус кольца магнита при подборе, игровые единицы. */
const MAGNET_RING_UNITS = 120;
/** Волны магнита и динамита — крупной текстурой и дольше обычного взрыва. */
const WAVE_TEXTURE_UNITS = 128;
const WAVE_LIFETIME_TICKS = 30;

function isWave(kind: number): boolean {
  return kind === SIM_EVENT.magnet || kind === SIM_EVENT.dynamite;
}
/** Радиус кольца лечения при подборе аптечки, игровые единицы. */
const HEAL_RING_UNITS = 40;

/** Сколько тиков держится вспышка попадания — около двух десятых секунды. */
const HIT_FLASH_TICKS = 7;

const LOOK = {
  normal: 0,
  /** телеграф: враг вот-вот атакует */
  warning: 1,
  /** второй такт мигания */
  dim: 2,
  /** только что получил урон */
  hit: 3,
  /**
   * Основа кодов тона состояния: `status + STATUS_TONE.*`. Сам `status` —
   * тон «нет», тот же обычный вид.
   */
  status: 10,
} as const;


/**
 * Мигание телеграфа по тикам симуляции: рывок мигает медленнее, фитиль — чаще,
 * чтобы угрозы различались ещё и ритмом.
 */
function lookFor(pattern: EnemyPattern, phase: number, tick: number): number {
  if (pattern === "dash" && phase === DASH_PHASE.telegraph) {
    return (tick >> 3) % 2 === 0 ? LOOK.warning : LOOK.dim;
  }
  if (pattern === "exploder" && phase === EXPLODER_PHASE.fuse) {
    return (tick >> 2) % 2 === 0 ? LOOK.warning : LOOK.dim;
  }
  if (pattern === "caster" && phase === CASTER_PHASE.windup) {
    return (tick >> 2) % 2 === 0 ? LOOK.warning : LOOK.normal;
  }
  return LOOK.normal;
}
