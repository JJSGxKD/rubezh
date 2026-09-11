/** Снаряд без владельца-врага: выпущен игроком. */
export const NO_OWNER_TYPE = 255;

/**
 * Пулы хранятся как структура массивов (SoA), а не массив объектов: обход
 * идёт по непрерывной памяти, а «убийство» врага не создаёт мусора — слот
 * помечается свободным и переиспользуется.
 */
export interface EnemyPool {
  x: Float32Array;
  y: Float32Array;
  /** позиции на предыдущем тике — для интерполяции при отрисовке */
  prevX: Float32Array;
  prevY: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  hp: Float32Array;
  /** таймер до следующей атаки: и контактной, и выстрела для kite_and_shoot */
  attackCooldown: Float32Array;
  type: Uint8Array;
  alive: Uint8Array;
  /**
   * Состояние паттерна: фаза и её таймер, зафиксированное направление,
   * текущий радиус кольца. Смысл фаз задаёт сам паттерн; нулевая фаза —
   * всегда «только что появился», её выставляет спавн.
   */
  phase: Uint8Array;
  phaseTimer: Float32Array;
  dirX: Float32Array;
  dirY: Float32Array;
  ringRadius: Float32Array;
  /** верхняя граница занятых слотов — обходим только её, а не всю ёмкость */
  count: number;
  aliveCount: number;
}

export interface ProjectilePool {
  x: Float32Array;
  y: Float32Array;
  prevX: Float32Array;
  prevY: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  damage: Float32Array;
  ttl: Float32Array;
  /** 1 — снаряд игрока, 0 — снаряд врага */
  fromPlayer: Uint8Array;
  /** индекс типа врага, выпустившего снаряд; NO_OWNER_TYPE — снаряд игрока */
  ownerType: Uint8Array;
  alive: Uint8Array;
  count: number;
  aliveCount: number;
}

/** Вся память пула выделяется один раз, при создании мира. */
export function createEnemyPool(capacity: number): EnemyPool {
  return {
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    prevX: new Float32Array(capacity),
    prevY: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    hp: new Float32Array(capacity),
    attackCooldown: new Float32Array(capacity),
    type: new Uint8Array(capacity),
    alive: new Uint8Array(capacity),
    phase: new Uint8Array(capacity),
    phaseTimer: new Float32Array(capacity),
    dirX: new Float32Array(capacity),
    dirY: new Float32Array(capacity),
    ringRadius: new Float32Array(capacity),
    count: 0,
    aliveCount: 0,
  };
}

export function createProjectilePool(capacity: number): ProjectilePool {
  return {
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    prevX: new Float32Array(capacity),
    prevY: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    damage: new Float32Array(capacity),
    ttl: new Float32Array(capacity),
    fromPlayer: new Uint8Array(capacity),
    ownerType: new Uint8Array(capacity).fill(NO_OWNER_TYPE),
    alive: new Uint8Array(capacity),
    count: 0,
    aliveCount: 0,
  };
}
