import type { RunCues } from "../../run-api";
import { DASH_PHASE, EXPLODER_PHASE, isElite } from "../patterns";
import { SIM_EVENT } from "../sim/events";
import type { World } from "../sim/world";

/**
 * Сигналы забега для вибрации и звука (docs/26-stage2-plan.md, WP14): что
 * случилось с прошлого опроса — попадания, подборы, взрывы, убийства,
 * срабатывания оружия.
 *
 * Считается из того, что мир и так пишет — буфера событий и счётчиков, — а
 * не новыми вызовами из симуляции: звук и вибрация к исходу забега отношения
 * не имеют и в детерминированный шаг не попадают.
 *
 * Объект сигналов переиспользуется: слушатель читает его сразу и не хранит.
 */

/** Взрыв «рядом» — в пределах радиуса плюс этот запас: игрок его почувствовал. */
const NEAR_MARGIN_UNITS = 80;

export class CueTracker {
  private readonly cues: RunCues = emptyCues();
  private eventsRead: number;
  private kills: number;
  private eliteKills: number;
  private xp: number;
  private elitesAlive: number;
  private readonly lastCooldown: number[] = [];
  private readonly enemyAlive: Uint8Array;
  private readonly enemyType: Uint8Array;
  private readonly enemyPhase: Uint8Array;
  private readonly enemyCooldown: Float32Array;

  constructor(private readonly world: World) {
    const capacity = world.enemies.alive.length;
    this.enemyAlive = new Uint8Array(capacity);
    this.enemyType = new Uint8Array(capacity);
    this.enemyPhase = new Uint8Array(capacity);
    this.enemyCooldown = new Float32Array(capacity);
    this.eventsRead = world.events.written;
    this.kills = world.stats.enemiesKilled;
    this.eliteKills = countEliteKills(world);
    this.xp = world.stats.xpCollected;
    this.elitesAlive = this.scanEnemies(null);
    this.rememberCooldowns();
  }

  /** Сигналы с прошлого опроса; `null` — ничего не случилось. */
  collect(): RunCues | null {
    const world = this.world;
    const cues = this.cues;
    resetCues(cues);
    let any = false;

    const events = world.events;
    const capacity = events.kind.length;
    const near = NEAR_MARGIN_UNITS * world.config.unitScale;
    for (let seq = Math.max(this.eventsRead, events.written - capacity); seq < events.written; seq++) {
      const slot = seq % capacity;
      const kind = events.kind[slot];
      if (kind === SIM_EVENT.playerHit) cues.playerHit++;
      else if (kind === SIM_EVENT.heal) cues.heal++;
      else if (kind === SIM_EVENT.magnet) cues.magnet++;
      else if (kind === SIM_EVENT.dynamite) cues.dynamite++;
      else if (kind === SIM_EVENT.strike) cues.strikes++;
      else if (kind === SIM_EVENT.explosion) {
        cues.explosions++;
        const dx = (events.x[slot] ?? 0) - world.player.x;
        const dy = (events.y[slot] ?? 0) - world.player.y;
        const reach = (events.radius[slot] ?? 0) + near;
        if (dx * dx + dy * dy <= reach * reach) cues.explosionsNear++;
      } else continue;
      any = true;
    }
    this.eventsRead = events.written;

    const kills = world.stats.enemiesKilled;
    if (kills > this.kills) {
      cues.kills = kills - this.kills;
      any = true;
    }
    this.kills = kills;

    const eliteKills = countEliteKills(world);
    if (eliteKills > this.eliteKills) {
      cues.eliteKills = eliteKills - this.eliteKills;
      any = true;
    }
    this.eliteKills = eliteKills;

    const xp = world.stats.xpCollected;
    if (xp > this.xp) {
      cues.xp = xp - this.xp;
      any = true;
    }
    this.xp = xp;

    const elitesAlive = this.scanEnemies(cues);
    if (cues.fuses > 0 || cues.dashWarns > 0 || cues.dashes > 0 || cues.enemyShots > 0) any = true;
    // Появление элиты — это рост числа живых сверх убитых за то же окно.
    const spawned = elitesAlive - this.elitesAlive + cues.eliteKills;
    if (spawned > 0) {
      cues.eliteSpawns = spawned;
      any = true;
    }
    this.elitesAlive = elitesAlive;

    const weapons = world.loadout.weapons;
    for (let slot = 0; slot < weapons.length; slot++) {
      const weapon = weapons[slot];
      if (weapon === undefined) continue;
      // Перезарядка выросла — оружие сработало: после удара она взводится заново.
      if (weapon.cooldown > (this.lastCooldown[slot] ?? 0) + 1e-6) {
        const id = world.weaponTypes[weapon.typeIndex]?.id ?? "";
        cues.weapons[id] = (cues.weapons[id] ?? 0) + 1;
        any = true;
      }
      this.lastCooldown[slot] = weapon.cooldown;
    }

    return any ? cues : null;
  }

  private rememberCooldowns(): void {
    this.world.loadout.weapons.forEach((weapon, slot) => {
      this.lastCooldown[slot] = weapon.cooldown;
    });
  }

  /**
   * Один проход по врагам: начала угроз — переход в фазу фитиля, телеграфа
   * или рывка, взведённая перезарядка стрелка — и число живых элит. Сравнение
   * идёт с тем же врагом в слоте: только что появившийся не «начинает» угрозу.
   */
  private scanEnemies(cues: RunCues | null): number {
    const world = this.world;
    const enemies = world.enemies;
    let elites = 0;
    for (let i = 0; i < enemies.count; i++) {
      const alive = enemies.alive[i] === 1;
      const typeIndex = enemies.type[i];
      const phase = enemies.phase[i];
      const cooldown = enemies.attackCooldown[i];
      const same = alive && this.enemyAlive[i] === 1 && this.enemyType[i] === typeIndex;
      if (alive) {
        const type = world.enemyTypes[typeIndex];
        if (type !== undefined && isElite(type)) elites++;
        if (same && cues !== null && type !== undefined && phase !== this.enemyPhase[i]) {
          if (type.pattern === "exploder" && phase === EXPLODER_PHASE.fuse) cues.fuses++;
          else if (type.pattern === "dash" && phase === DASH_PHASE.telegraph) cues.dashWarns++;
          else if (type.pattern === "dash" && phase === DASH_PHASE.dash) cues.dashes++;
        }
        if (same && cues !== null && type?.pattern === "kite_and_shoot" && cooldown > this.enemyCooldown[i] + 1e-6) {
          cues.enemyShots++;
        }
      }
      this.enemyAlive[i] = alive ? 1 : 0;
      this.enemyType[i] = typeIndex;
      this.enemyPhase[i] = phase;
      this.enemyCooldown[i] = cooldown;
    }
    return elites;
  }
}

function emptyCues(): RunCues {
  return {
    playerHit: 0,
    heal: 0,
    magnet: 0,
    dynamite: 0,
    explosions: 0,
    explosionsNear: 0,
    strikes: 0,
    kills: 0,
    eliteKills: 0,
    eliteSpawns: 0,
    xp: 0,
    fuses: 0,
    dashWarns: 0,
    dashes: 0,
    enemyShots: 0,
    weapons: {},
  };
}

function resetCues(cues: RunCues): void {
  cues.playerHit = 0;
  cues.heal = 0;
  cues.magnet = 0;
  cues.dynamite = 0;
  cues.explosions = 0;
  cues.explosionsNear = 0;
  cues.strikes = 0;
  cues.kills = 0;
  cues.eliteKills = 0;
  cues.eliteSpawns = 0;
  cues.xp = 0;
  cues.fuses = 0;
  cues.dashWarns = 0;
  cues.dashes = 0;
  cues.enemyShots = 0;
  for (const id of Object.keys(cues.weapons)) cues.weapons[id] = 0;
}

function countEliteKills(world: World): number {
  let total = 0;
  world.enemyTypes.forEach((type, index) => {
    if (isElite(type)) total += world.stats.killsByType[index] ?? 0;
  });
  return total;
}
