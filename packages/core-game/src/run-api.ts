import type { DifficultyId, RunOutcome, RunResult, UpgradeOption } from "@bh/shared-types";

/**
 * Публичный контракт забега: чем оболочка приложения управляет движком и что
 * получает обратно (docs/27-design-system-and-app-shell.md §3.1).
 *
 * Три свойства, ради которых он такой:
 *
 * - **команды и события, а не общее состояние.** Оболочка не читает мир
 *   напрямую и не держит на него ссылку — иначе React-компонент однажды
 *   подпишется на позицию врага и начнёт перерисовываться 60 раз в секунду;
 * - **выбор улучшения — команда**, которая применяется на границе тика и
 *   пишется в лог ввода: забег остаётся воспроизводимым;
 * - **движок не ходит в сеть.** Он отдаёт `RunResult`, отправкой занимается
 *   оболочка (docs/15-engineering-standards.md §2.2).
 *
 * Здесь только типы: файл не тянет ни Phaser, ни симуляцию, поэтому его
 * можно импортировать из оболочки, не утаскивая движок в основной бандл.
 */

/** Снимок состояния для HUD. Приходит не чаще 10 раз в секунду. */
/**
 * Босс на поле: полоса здоровья на экране (docs/27-design-system-and-app-shell.md §3.3).
 *
 * Только у босса, не у элиты: элит за забег приходят десятки, и полоса на
 * каждую превратилась бы в фон. Бой с боссом — отдельное событие забега, и
 * игрок должен видеть, сколько ему осталось.
 */
export interface BossSnapshot {
  /** id врага из контента — имя оболочка берёт по нему сама */
  enemyId: string;
  hp: number;
  maxHp: number;
  /** фаза боя: считается от остатка здоровья, чем выше — тем злее */
  phase: number;
  /** сколько фаз всего — столько делений на полосе */
  phases: number;
}

export interface HudSnapshot {
  survivalSec: number;
  hp: number;
  maxHp: number;
  level: number;
  /** опыт на текущем уровне и порог следующего */
  xp: number;
  xpToNext: number;
  /** отрезок таймлайна спавна — «волна» в аналитике */
  wave: number;
  enemiesAlive: number;
  enemiesKilled: number;
  weapons: RunSlotState[];
  passives: RunSlotState[];
  /** пройденное расстояние в игровых единицах — подсказки обучения гаснут, когда игрок пошёл */
  distance: number;
  /** точки радара вокруг игрока */
  radar: RadarSnapshot;
  /** живой босс, если он на поле; у элиты полосы нет */
  boss: BossSnapshot | null;
}

/**
 * Вид точки радара. Числом, а не строкой: точки лежат в типизированном
 * массиве, и снимок не плодит объектов. Подборы различаются видом — на радаре
 * игрок решает, за чем бежать, и магнит, нарисованный аптечкой, его обманывает.
 */
export const RADAR_BLIP = {
  enemy: 0,
  elite: 1,
  medkit: 2,
  magnet: 3,
  dynamite: 4,
} as const;

export type RadarBlipKind = (typeof RADAR_BLIP)[keyof typeof RADAR_BLIP];

/**
 * Радар — что вокруг игрока в пределах кольца спавна, в том числе за краем
 * экрана. Координаты — доли радиуса радара от −1 до 1 относительно игрока;
 * дальние точки прижаты к краю, чтобы угроза оттуда не пропадала.
 */
export interface RadarSnapshot {
  /** тройки подряд: x, y, вид (`RadarBlipKind`) */
  blips: Float32Array;
  count: number;
}

export interface RunSlotState {
  id: string;
  level: number;
}

/**
 * Характеристики забега по запросу — лист «Характеристики» на паузе и на
 * выборе улучшения. Снимается, только когда его просят, а не в каждом снимке
 * HUD: мир в этот момент стоит, и считать его десять раз в секунду незачем.
 *
 * Расстояния и скорости — в игровых единицах, как в контенте, а не в пикселях
 * устройства: иначе у игрока с плотным экраном «скорость бега» была бы вдвое
 * больше, чем у соседа.
 */
export interface RunInspection {
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  damageTaken: number;
  player: {
    hp: number;
    maxHp: number;
    regenPerSec: number;
    armor: number;
    moveSpeed: number;
    pickupRadius: number;
    damageMul: number;
    cooldownMul: number;
    areaMul: number;
    projectileSpeedMul: number;
    extraProjectiles: number;
  };
  weapons: RunWeaponInspection[];
  passives: RunPassiveInspection[];
}

export interface RunWeaponInspection {
  id: string;
  behavior: string;
  level: number;
  maxLevel: number;
  /** числа с учётом пассивок — ровно то, чем оружие бьёт сейчас */
  damage: number;
  cooldownSec: number;
  projectiles: number;
  pierce: number;
  areaRadius: number;
  damageDealt: number;
  /** доля урона оружия в забеге, от 0 до 1 */
  damageShare: number;
  /** средний урон в секунду за весь забег */
  dps: number;
}

export interface RunPassiveInspection {
  id: string;
  category: string;
  level: number;
  maxLevel: number;
  stat: string;
  op: "add" | "mul";
  /** значение уровня: множитель или слагаемое, как в контенте */
  value: number;
}

/**
 * Почему забег стоит: игрок нажал паузу, приложение ушло в фон или забег
 * только что продолжен из снимка и ждёт, пока игрок будет готов.
 */
export type RunPauseReason = "manual" | "app_inactive" | "restored";

/**
 * Версия формата снимка. Меняется при любой правке снимка или мира: старое
 * сохранение тогда не продолжается, а не продолжается криво.
 */
export const RUN_SNAPSHOT_FORMAT = 5;

/**
 * Снимок прерванного забега — по нему забег продолжается после сворачивания,
 * вылета или перезапуска. Для оболочки он непрозрачен: она хранит его и
 * отдаёт обратно, а сама читает только заголовок и `summary` — для карточки
 * «Продолжить» в лобби.
 *
 * Снимок годится только для того контента, на котором снят: `contentHash`
 * другой — продолжать нельзя, числа врагов и оружия уже другие.
 */
export interface RunSnapshot {
  format: number;
  contentHash: string;
  runId: string;
  seed: number;
  mapId: string;
  difficultyId: DifficultyId;
  startingWeaponId: string;
  summary: RunSnapshotSummary;
  /** состояние мира; формат знает только движок */
  world: unknown;
  /**
   * Забег уже помечен как с читами. Необязательное: снимок прошлой сборки поля
   * не знает, и это обычный забег — формат из-за него не меняется.
   */
  cheats?: boolean;
  /**
   * Забег шёл в режиме разработчика. Отдельно от `cheats`: панель могла быть
   * открыта, а читами игрок не пользовался — и продолженный забег обязан
   * остаться забегом разработчика, а не превратиться тихо в обычный.
   */
  dev?: boolean;
}

export interface RunSnapshotSummary {
  survivalSec: number;
  level: number;
  weapons: RunSlotState[];
  passives: RunSlotState[];
}

export interface RunOptions {
  /** куда встроить канву забега */
  container: HTMLElement;
  seed: number;
  /** на старте режим один — бесконечный (решение Р8) */
  mode: "endless";
  mapId: string;
  /** уровень сложности; неизвестный id — базовая сложность без поправок */
  difficultyId: DifficultyId;
  startingWeaponId: string;
  diagnostics: RunDiagnosticsOptions;
  /** настройки графики игрока; без них рисуется всё */
  graphics?: RunGraphicsOptions;
  /**
   * Физических пикселей на CSS-пиксель. Передаётся снаружи, а не читается из
   * `devicePixelRatio`: стенд испытаний фиксирует его, чтобы прогоны на
   * разных экранах были сравнимы.
   */
  pixelRatio?: number;
  /** ограничение частоты отрисовки — только для замеров */
  renderCapFps?: number;
  /**
   * Продолжить забег из снимка. `seed`, карта, сложность и оружие тогда
   * берутся из снимка, а забег стартует на паузе с причиной `restored`.
   */
  resume?: RunSnapshot;
  /** забег разработчика; без поля — обычный забег, команды разработчика не работают */
  dev?: RunDevOptions;
}

/**
 * Что рисовать в забеге (docs/27-design-system-and-app-shell.md §8). Это
 * настройки игрока, а не отладка: телеграфы и эффекты помогают читать бой, но
 * на слабом устройстве их можно снять.
 */
export interface RunGraphicsOptions {
  /** телеграфы угроз: прицел стрелка, круг взрыва, полоса рывка */
  telegraphs: boolean;
  /** эффекты оружия: молния «Грозы», граница «Очага» */
  weaponEffects: boolean;
  /** всплывающие числа урона и вспышки гибели */
  damageNumbers: boolean;
}

export interface RunDiagnosticsOptions {
  /** полная запись забега: таймлайн, события и лог ввода (docs/28-diagnostics.md §3.3) */
  recordRun: boolean;
  /** оверлей FPS поверх забега */
  fpsOverlay: boolean;
}

export interface RunEvents {
  /** снимок для HUD, не чаще 10 Гц */
  hud: HudSnapshot;
  /** начался новый отрезок таймлайна спавна — `wave_reached` в аналитике */
  waveReached: { index: number; elapsedSec: number };
  /** набран уровень: мир стоит, пока оболочка не вернёт выбор */
  levelUp: { level: number; options: UpgradeOption[]; queued: number };
  paused: { reason: RunPauseReason; elapsedSec: number };
  resumed: { elapsedSec: number };
  /** техническая сводка — только с `diagnostics.fpsOverlay` или `dev.visuals.techInfo` */
  devInfo: RunDevInfo;
  /**
   * Что случилось в забеге с прошлой сводки — для вибрации и звука, не чаще
   * 30 раз в секунду и только когда что-то случилось. Объект переиспользуется:
   * читать сразу, не хранить.
   */
  cues: RunCues;
  /** забег кончился смертью */
  finished: RunResult;
  /** игрок сдался на экране паузы */
  abandoned: RunResult;
  /**
   * Технический итог забега — сразу перед `finished` или `abandoned`, в том
   * же вызове: оболочка кладёт сводку в событие итога.
   */
  diagnostics: RunDiagnostics;
  error: { message: string };
}

/** Технический итог забега (docs/28-diagnostics.md §3). */
export interface RunDiagnostics {
  perf: RunPerfSummary;
  /** полная запись — только с `diagnostics.recordRun` */
  recording: RunRecording | null;
}

/** Версия формата записи. Меняется формат — растёт версия. */
export const RUN_RECORDING_SCHEMA = "rubezh.run.v1";

/**
 * Почему забег по записи не повторить:
 *
 * - `resumed` — забег продолжен из снимка, лог начинается с середины;
 * - `dev` — забег разработчика: читы и команды в лог не пишутся;
 * - `input_overflow` — лог ввода не влез в потолок.
 */
export type RunReplayBlocker = "resumed" | "dev" | "input_overflow";

/**
 * Полная запись забега (docs/28-diagnostics.md §3.3–§3.4): по ней видно, где
 * и почему было плохо, и по ней же забег повторяется headless.
 */
export interface RunRecording {
  schema: typeof RUN_RECORDING_SCHEMA;
  /** ключ идемпотентности отчёта: создаётся в начале забега */
  reportId: string;
  runId: string;
  /** UTC */
  startedAt: string;
  seed: number;
  mapId: string;
  difficultyId: DifficultyId;
  startingWeaponId: string;
  contentHash: string;
  /** физических пикселей на игровую единицу — мир считается в них, повтору он нужен */
  unitScale: number;
  outcome: RunOutcome;
  /** `null` — забег повторяется */
  replayBlocker: RunReplayBlocker | null;
  result: RunRecordingResult;
  /** строка видеоадаптера WebGL — где браузер её отдаёт */
  gpu: string | null;
  perf: RunPerfSummary;
  timeline: RunTimelineBucket[];
  /** забег дольше часа — таймлайн обрезан */
  timelineTruncated: boolean;
  events: RunRecordingEvent[];
  eventsTruncated: boolean;
  input: RunInputLog;
  /** выборы улучшений: тик и вариант */
  choices: [tick: number, optionId: string][];
  /** свёртка мира раз в минуту забега: где повтор разошёлся с оригиналом */
  checkpoints: [tick: number, checksum: number][];
}

export interface RunRecordingResult {
  ticks: number;
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  deathCause: string | null;
  checksum: number;
}

export interface RunInputLog {
  encoding: "rle-v1";
  ticks: number;
  /** base64 серий: см. `game/diagnostics/input-log.ts` */
  data: string;
  truncated: boolean;
}

/**
 * Событие забега с тиком симуляции: `wave` — начало отрезка таймлайна,
 * `level` — набран уровень, `offer` — варианты через запятую, `choice` —
 * выбор, `pause` — с причиной, `resume`, `resize` — «ширина×высота» канвы,
 * `death` — причина смерти, `abandon` — сдался.
 */
export type RunRecordingEvent = [tick: number, kind: RunRecordingEventKind, value: string | number | null];

export type RunRecordingEventKind = "wave" | "level" | "offer" | "choice" | "pause" | "resume" | "resize" | "death" | "abandon";

/** Корзина таймлайна записи — пять секунд кадров, которым можно верить. */
export interface RunTimelineBucket {
  /** начало корзины по времени кадров, без пауз и фона */
  startSec: number;
  /** тик симуляции в конце корзины */
  tick: number;
  wave: number;
  frames: number;
  avgFps: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  over33Ratio: number;
  /** среднее время одного шага симуляции */
  simMsAvg: number;
  /** самое долгое время шагов за кадр */
  simMsMax: number;
  /** больше одного — устройство не успевало, игра замедлялась */
  maxSteps: number;
  /** кадров с догонянием: больше одного шага за кадр */
  catchUpFrames: number;
  renderMsAvg: number;
  enemies: number;
  projectiles: number;
  maxObjects: number;
  heapMb: number | null;
}

/**
 * Сводка производительности — у всех игроков, в `run_finished`
 * (docs/28-diagnostics.md §3.2). Первые две секунды и кадры после сворачивания
 * в неё не входят.
 */
export interface RunPerfSummary {
  /** сколько кадров вошло в оценку: мало — цифрам верить нельзя */
  frames: number;
  durationSec: number;
  avgFps: number;
  p95FrameMs: number;
  /** доля кадров дольше 33 мс */
  over33Ratio: number;
  /** пик врагов и снарядов вместе — сумма в один момент */
  peakObjects: number;
  /** оценка частоты экрана: без неё FPS не с чем сравнивать */
  displayHz: number;
  /** ограничение частоты отрисовки; `null` — рисуем со скоростью экрана */
  renderCapFps: number | null;
  renderer: "webgl" | "canvas";
  dpr: number;
  canvasWidth: number;
  canvasHeight: number;
  /** сколько раз забег прерывался сворачиванием */
  interruptions: number;
}

export interface RunSession {
  on<E extends keyof RunEvents>(event: E, handler: (payload: RunEvents[E]) => void): () => void;
  chooseUpgrade(optionId: string): void;
  pause(reason: RunPauseReason): void;
  resume(): void;
  abandon(): void;
  /** начать заново в уже загруженном движке: от смерти до забега один тап */
  restart(seed: number): void;
  /**
   * Снять снимок для продолжения. `null`, если продолжать нечего: забег
   * кончился или сцена ещё не создана.
   */
  snapshot(): RunSnapshot | null;
  /** характеристики забега; `null`, пока сцена не создана */
  inspect(): RunInspection | null;
  /**
   * Настройки режима разработчика на ходу — с паузы и перед «Ещё раз». У
   * забега, начатого без `dev`, команда ничего не делает: режим не
   * включается посреди обычного забега.
   */
  setDev(options: RunDevOptions): void;
  /** разовое действие разработчика на границе тика */
  devCommand(command: RunDevCommand): void;
  destroy(): void;
}

/**
 * Режим разработчика (docs/26-stage2-plan.md, WP14): отладочная отрисовка,
 * время и читы. Доступ решает оболочка по ответу сервера — движок доверяет
 * тому, что пришло в `RunOptions.dev`.
 */
export interface RunDevOptions {
  visuals: RunDevVisuals;
  cheats: RunDevCheats;
  /**
   * Скорость времени: 1 — обычная, 0.25 — замедление вчетверо. Сверху
   * ограничена потолком шагов за кадр — ускорение не бывает дороже пяти шагов.
   */
  timeScale: number;
  /**
   * Команды на старте нового забега и на «Ещё раз» — «весь арсенал», «сразу
   * десятая минута». Продолженный из снимка забег их не получает: он уже шёл.
   */
  start: RunDevCommand[];
}

export interface RunDevVisuals {
  /** круги столкновений игрока, врагов и снарядов */
  hitboxes: boolean;
  /** радиус подбора кристаллов и подборов */
  pickupRadius: boolean;
  /** площадь ауры, кольцо оберегов, дальность стрельбы */
  weaponRadii: boolean;
  /** кольца спавна и удержания врагов */
  spawnRings: boolean;
  /** границы карты, если они есть */
  bounds: boolean;
  /** клетки сетки столкновений вокруг игрока */
  grid: boolean;
  /** телеграфы угроз; выключить — сравнить, как читается бой без них */
  telegraphs: boolean;
  /** всплывающие числа урона и вспышки гибели */
  damageNumbers: boolean;
  /** эффекты оружия: граница ауры, молнии, взрывы */
  effects: boolean;
  /** техническая сводка событием `devInfo` */
  techInfo: boolean;
}

export interface RunDevCheats {
  godMode: boolean;
  oneHitKill: boolean;
  damageMul: number;
  moveSpeedMul: number;
  freezeEnemies: boolean;
  /** директор спавна стоит: новые враги не приходят */
  spawnPaused: boolean;
}

export type RunDevPickup = "medkit" | "magnet" | "dynamite";

export type RunDevCommand =
  | { kind: "levelUp"; count: number }
  | { kind: "giveWeapon"; id: string; level: number }
  | { kind: "givePassive"; id: string; level: number }
  | { kind: "spawnEnemy"; id: string; count: number }
  | { kind: "spawnPickup"; pickup: RunDevPickup }
  | { kind: "spawnGems"; value: number; count: number }
  | { kind: "killAll" }
  | { kind: "heal" }
  | { kind: "jumpToMinute"; minute: number }
  /** шаг симуляции на паузе — разглядеть телеграф или столкновение по тикам */
  | { kind: "stepTicks"; ticks: number };

/** Сигналы забега за окно: счётчики, а не отдельные события — толпа не превращается в сотни вызовов. */
export interface RunCues {
  playerHit: number;
  /** подобрана аптечка */
  heal: number;
  magnet: number;
  dynamite: number;
  /** взрывы подрывников; `explosionsNear` — из них рядом с игроком */
  explosions: number;
  explosionsNear: number;
  /** удары молний «Грозы» */
  strikes: number;
  kills: number;
  eliteKills: number;
  eliteSpawns: number;
  /** собранный опыт — кристаллы */
  xp: number;
  /** начала угроз: подрывник поджёг фитиль, волк замер перед рывком и рванул, стрелок выстрелил */
  fuses: number;
  dashWarns: number;
  dashes: number;
  enemyShots: number;
  /** срабатывания оружия: id оружия → сколько раз */
  weapons: Record<string, number>;
}

/** Техническая сводка для оверлея разработчика и FPS тестировщика — четыре раза в секунду. */
export interface RunDevInfo {
  fps: number;
  /** среднее время кадра за окно, мс */
  frameMs: number;
  /** среднее время одного шага симуляции, мс */
  simMs: number;
  /** шагов симуляции за кадр в среднем: больше одного — кадры не успевают */
  stepsPerFrame: number;
  tick: number;
  elapsedSec: number;
  seed: number;
  enemies: number;
  projectiles: number;
  gems: number;
  pickups: number;
  /** отрезок таймлайна и его множители с учётом сложности */
  segment: number;
  hpMul: number;
  damageMul: number;
  maxAlive: number;
  zoom: number;
  /** позиция игрока в игровых единицах */
  playerX: number;
  playerY: number;
  timeScale: number;
  /** забег уже помечен как с читами */
  cheats: boolean;
}

export interface RunEngine {
  start(options: RunOptions): RunSession;
}
