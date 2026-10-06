/** Снаряд без владельца-врага: выпущен игроком. */
export const NO_OWNER_TYPE = 255;

/** Тик «попаданий не было»: заведомо раньше любого тика забега. */
export const NEVER_HIT = -1000;

/**
 * Пулы хранятся как структура массивов (SoA), а не массив объектов: обход
 * идёт по непрерывной памяти, а «убийство» врага не создаёт мусора — слот
 * помечается свободным и переиспользуется.
 */
/**
 * Позиции — двойной точности, а не одинарной.
 *
 * Мир бесконечен: за десятиминутный забег игрок уходит на сотню тысяч единиц
 * от старта, а там шаг `Float32` уже около сотой доли единицы и растёт дальше.
 * Движение начинает «залипать» на сетке представимых чисел, а два прогона с
 * одним seed расходятся от округления. Цена — килобайты памяти пулов
 * (docs/26-stage2-plan.md, WP4.1). Скорости, здоровье и таймеры остаются
 * одинарными: они не накапливают смещение от начала координат.
 */
export interface EnemyPool {
  x: Float64Array;
  y: Float64Array;
  /** позиции на предыдущем тике — для интерполяции при отрисовке */
  prevX: Float64Array;
  prevY: Float64Array;
  vx: Float32Array;
  vy: Float32Array;
  hp: Float32Array;
  /**
   * Здоровье, с которым враг вышел. В пуле, а не в типе: множители отрезка и
   * ступени застыли в нём при спавне, и полоса босса обязана мерить долю от
   * того здоровья, что у него было, а не от числа в контенте.
   */
  maxHp: Float32Array;
  /**
   * Урон этого врага. В пуле, а не в типе: кривая сложности после потолка
   * живых растёт здоровьем и уроном (docs/26-stage2-plan.md, WP4.4), и
   * множитель обязан застывать в момент спавна — иначе уже вышедший враг
   * усиливался бы задним числом вместе с таймлайном.
   */
  damage: Float32Array;
  /**
   * Тик последнего попадания. Нужен рендеру: без вспышки игрок не понимает,
   * попал он или снаряд прошёл мимо, и бой читается как набор случайностей.
   * Хранится в пуле, а не в буфере событий: попаданий за тик бывают десятки,
   * и кольцевой буфер эффектов они вытеснили бы целиком.
   */
  hitTick: Int32Array;
  /** таймер до следующей атаки: и контактной, и выстрела для kite_and_shoot */
  attackCooldown: Float32Array;
  type: Uint8Array;
  /**
   * Ступень врага (content/stages.ts). В пуле, а не в типе: ступень
   * выбирается при спавне и застывает — иначе уже вышедший враг матерел бы
   * задним числом вместе с таймлайном.
   */
  stage: Uint8Array;
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
  /**
   * Состояния стихий (`sim/elements.ts`): таймеры в секундах, урон по
   * времени в секунду, копилка охлаждения до заморозки, слои яда и чьё
   * оружие наложило горение и яд — урон по времени засчитывается ему.
   */
  burnTimer: Float32Array;
  burnDps: Float32Array;
  burnSlot: Uint8Array;
  chillTimer: Float32Array;
  chillBuild: Uint8Array;
  frozenTimer: Float32Array;
  shockTimer: Float32Array;
  poisonTimer: Float32Array;
  poisonStacks: Uint8Array;
  poisonDps: Float32Array;
  poisonSlot: Uint8Array;
  /** верхняя граница занятых слотов — обходим только её, а не всю ёмкость */
  count: number;
  aliveCount: number;
}

export interface ProjectilePool {
  x: Float64Array;
  y: Float64Array;
  prevX: Float64Array;
  prevY: Float64Array;
  vx: Float32Array;
  vy: Float32Array;
  damage: Float32Array;
  ttl: Float32Array;
  /** 1 — снаряд игрока, 0 — снаряд врага */
  fromPlayer: Uint8Array;
  /** индекс типа врага, выпустившего снаряд; NO_OWNER_TYPE — снаряд игрока */
  ownerType: Uint8Array;
  /** индекс оружия игрока — по нему считается урон по оружиям для итогов */
  ownerWeapon: Uint8Array;
  /** сколько врагов снаряд ещё может пробить, прежде чем исчезнуть */
  pierce: Uint8Array;
  /**
   * Кого снаряд задел последним. Пробивающий снаряд перекрывается с врагом
   * несколько тиков подряд, и без этой отметки он бил бы одного и того же
   * врага каждый тик, а не пробивал бы дальше.
   */
  lastHit: Int16Array;
  /** стихия урона снаряда (`sim/elements.ts`) и шанс наложить её состояние */
  element: Uint8Array;
  statusChance: Float32Array;
  alive: Uint8Array;
  count: number;
  aliveCount: number;
}

/** Вся память пула выделяется один раз, при создании мира. */
export function createEnemyPool(capacity: number): EnemyPool {
  return {
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    prevX: new Float64Array(capacity),
    prevY: new Float64Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    hp: new Float32Array(capacity),
    maxHp: new Float32Array(capacity),
    damage: new Float32Array(capacity),
    hitTick: new Int32Array(capacity).fill(NEVER_HIT),
    attackCooldown: new Float32Array(capacity),
    type: new Uint8Array(capacity),
    stage: new Uint8Array(capacity),
    alive: new Uint8Array(capacity),
    phase: new Uint8Array(capacity),
    phaseTimer: new Float32Array(capacity),
    dirX: new Float32Array(capacity),
    dirY: new Float32Array(capacity),
    ringRadius: new Float32Array(capacity),
    burnTimer: new Float32Array(capacity),
    burnDps: new Float32Array(capacity),
    burnSlot: new Uint8Array(capacity),
    chillTimer: new Float32Array(capacity),
    chillBuild: new Uint8Array(capacity),
    frozenTimer: new Float32Array(capacity),
    shockTimer: new Float32Array(capacity),
    poisonTimer: new Float32Array(capacity),
    poisonStacks: new Uint8Array(capacity),
    poisonDps: new Float32Array(capacity),
    poisonSlot: new Uint8Array(capacity),
    count: 0,
    aliveCount: 0,
  };
}

/**
 * Кристаллы опыта. Третья популяция объектов после врагов и снарядов, и она
 * растёт быстрее всех: кристалл остаётся от каждого убитого врага. Поэтому у
 * пула жёсткий потолок, а при его достижении кристаллы сливаются
 * (`sim/gems.ts`), а не копятся до конца забега.
 */
export interface GemPool {
  /** куда кристалл упал; до приземления рендер ведёт его сюда от места смерти */
  x: Float64Array;
  y: Float64Array;
  prevX: Float64Array;
  prevY: Float64Array;
  /** место смерти врага: откуда кристалл вылетел */
  originX: Float64Array;
  originY: Float64Array;
  /**
   * Тик вылета. Пока кристалл в полёте, его нельзя подобрать: иначе он
   * исчезает в игроке, так и не долетев до земли. `NEVER_HIT` — положен сразу,
   * без полёта (слияние, тесты).
   */
  bornTick: Int32Array;
  value: Float32Array;
  /** 1 — кристалл уже притягивается к игроку и не сливается с другими */
  attracted: Uint8Array;
  alive: Uint8Array;
  count: number;
  aliveCount: number;
}

export function createGemPool(capacity: number): GemPool {
  return {
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    prevX: new Float64Array(capacity),
    prevY: new Float64Array(capacity),
    originX: new Float64Array(capacity),
    originY: new Float64Array(capacity),
    bornTick: new Int32Array(capacity).fill(NEVER_HIT),
    value: new Float32Array(capacity),
    attracted: new Uint8Array(capacity),
    alive: new Uint8Array(capacity),
    count: 0,
    aliveCount: 0,
  };
}

/**
 * Подборы: аптечки, магниты, динамит (`sim/pickups.ts`). Их на поле единицы —
 * потолок задаёт контент, — поэтому у пула нет слияния: не поместился, значит
 * не упал.
 */
export interface PickupPool {
  x: Float64Array;
  y: Float64Array;
  originX: Float64Array;
  originY: Float64Array;
  /** тик вылета; пока подбор летит, его не подобрать — как у кристалла */
  bornTick: Int32Array;
  /** вид подбора — `PICKUP_KIND` */
  kind: Uint8Array;
  alive: Uint8Array;
  count: number;
  aliveCount: number;
}

export function createPickupPool(capacity: number): PickupPool {
  return {
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    originX: new Float64Array(capacity),
    originY: new Float64Array(capacity),
    bornTick: new Int32Array(capacity).fill(NEVER_HIT),
    kind: new Uint8Array(capacity),
    alive: new Uint8Array(capacity),
    count: 0,
    aliveCount: 0,
  };
}

export function createProjectilePool(capacity: number): ProjectilePool {
  return {
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    prevX: new Float64Array(capacity),
    prevY: new Float64Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    damage: new Float32Array(capacity),
    ttl: new Float32Array(capacity),
    fromPlayer: new Uint8Array(capacity),
    ownerType: new Uint8Array(capacity).fill(NO_OWNER_TYPE),
    ownerWeapon: new Uint8Array(capacity).fill(NO_OWNER_TYPE),
    pierce: new Uint8Array(capacity),
    lastHit: new Int16Array(capacity).fill(-1),
    element: new Uint8Array(capacity),
    statusChance: new Float32Array(capacity),
    alive: new Uint8Array(capacity),
    count: 0,
    aliveCount: 0,
  };
}
