// Общие типы для всего монорепо.
// См. docs/01-tech-stack.md §1 и §4 — почему core-game не знает о платформе,
// а всё общение идёт через PlatformAdapter.

export type Platform = "telegram" | "max" | "vk" | "web";

export interface UserContext {
  id: string;
  platform: Platform;
  displayName: string;
  /** null, если платформа не отдаёт фото — см. docs/08-web-and-identity.md §4 */
  avatarUrl: string | null;
  /** только для telegram/web, см. docs/01-tech-stack.md §7 */
  locale?: string;
}

/**
 * Чем кончилось окно оплаты площадки. Это подсказка, а не факт оплаты: право
 * на покупку выдаёт сервер по подтверждению от площадки
 * (docs/34-stage3-plan.md, Р13).
 *
 * - `paid` — площадка говорит, что оплачено; `pending` — оплата ещё идёт;
 * - `cancelled` — игрок закрыл окно; `failed` — оплата не прошла;
 * - `unsupported` — окна нет: открыто вне клиента или клиент слишком старый.
 */
export type InvoiceStatus = "paid" | "pending" | "cancelled" | "failed" | "unsupported";

/**
 * Виды тактильного отклика — по возможностям Telegram: удар разной силы
 * (`light`…`heavy`, `soft`, `rigid`), уведомление (`success`, `warning`,
 * `error`) и щелчок выбора (`selection`). Площадка без такого вида берёт
 * ближайший или молчит.
 */
export type HapticType =
  | "light"
  | "medium"
  | "heavy"
  | "soft"
  | "rigid"
  | "selection"
  | "success"
  | "warning"
  | "error";

export interface AdResult {
  shown: boolean;
  rewarded: boolean;
}

/**
 * Единый интерфейс платформенного адаптера.
 * core-game и оболочка работают только через него и ничего не знают о
 * конкретной платформе. См. docs/01-tech-stack.md §1.
 */
export interface PlatformAdapter {
  init(): Promise<UserContext>;
  /**
   * Открыть счёт, который выставил сервер: в Telegram — ссылка на счёт Stars.
   * Цену назначает сервер, адаптер её не знает (docs/34-stage3-plan.md, Р5.1).
   * Нет метода — площадка оплату не умеет, и оболочка покупку не предлагает.
   */
  openInvoice?(url: string): Promise<InvoiceStatus>;
  share(payload: SharePayload): void;
  /**
   * Пригласить в игру: системный выбор чата площадки, а где его нет — копия
   * ссылки. Без награды: приглашение на плейтест, не реферальная программа
   * (docs/23-referral-and-partner-program.md).
   */
  invite(invite: InvitePayload): Promise<InviteResult>;
  /**
   * Подписанные данные запуска для сервера — в Telegram строка `initData`.
   * Сервер проверяет подпись и узнаёт по ней игрока; `null` — площадка их не
   * даёт (обычный браузер, dev), и сервер игрока не узнает.
   */
  signedLaunchData(): string | null;
  /**
   * Какой клиент площадки открыл игру — для статистики устройств плейтеста
   * и отчётов производительности. `null` в полях — площадка не сообщила.
   */
  clientInfo(): PlatformClientInfo;
  haptic(type: HapticType): void;
  /**
   * Возможности интерфейса площадки: отступы безопасной зоны, полноэкранный
   * режим, кнопки «назад» и «настройки», свайпы, активность приложения
   * (docs/27-design-system-and-app-shell.md §5.2).
   *
   * Обязателен, а не опционален: оболочка должна получить одинаковый набор от
   * любой площадки. Там, где площадка чего-то не умеет, адаптер возвращает
   * честные умолчания — заглушка лучше проверки `if (adapter.ui)` в каждом
   * компоненте.
   */
  ui: PlatformUi;
  /**
   * Имя и аватар из параметров запуска — **только для отображения**. Это не
   * проверенная личность: подпись `initData` проверяется на бэкенде, и до
   * этапа 3 этого не происходит вовсе (docs/08-web-and-identity.md §4).
   */
  displayUser: DisplayUser | null;
  /** опционально — не везде доступно, см. docs/01-tech-stack.md §6 */
  showAd?(): Promise<AdResult>;
  /** опционально — площадка может не дать хранилища, см. KeyValueStorage */
  storage?: KeyValueStorage;
}

/** Отписка от события площадки. */
export type Unsubscribe = () => void;

export interface DisplayUser {
  displayName: string;
  avatarUrl: string | null;
}

/** Отступы безопасной зоны в CSS-пикселях. */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Полноэкранный режим или обычный — выбор игрока (решение Р15). */
export type ScreenMode = "fullscreen" | "normal";

export interface ViewportState {
  width: number;
  /**
   * Стабильная высота вьюпорта в CSS-пикселях — от площадки, а не `100vh`:
   * во WebView iOS `100vh` включает зону под панелями, и нижняя кнопка
   * уезжает за край (docs/27-design-system-and-app-shell.md §5.1).
   */
  height: number;
  /**
   * Развёрнуто ли приложение на полную высоту. В компактном режиме забег
   * непригоден — вместо него экран с просьбой развернуть.
   */
  expanded: boolean;
}

export interface ThemeColors {
  header: string;
  background: string;
  bottomBar: string;
}

/**
 * Возможности интерфейса площадки.
 *
 * Оболочка знает только этот набор и никогда не обращается к SDK площадки
 * напрямую — иначе она становится телеграм-оболочкой, и портирование на MAX
 * превращается в её переписывание (docs/27-design-system-and-app-shell.md §2).
 *
 * Свойства читаются как текущее состояние, подписки сообщают об изменениях.
 * Каждая подписка возвращает функцию отписки: оболочка монтирует и
 * размонтирует экраны, и подписка без отписки — утечка на каждом переходе.
 */
export interface PlatformUi {
  /**
   * Подготовить возможности площадки: смонтировать SDK, подписаться на
   * события. До её завершения остальные свойства отдают честные умолчания, а
   * не врут: оболочка зовёт `ready()` на экране загрузки и только потом
   * показывает интерфейс. Повторный вызов ничего не делает.
   *
   * Не бросает: площадка недоступна — работаем в браузерном режиме, а не
   * падаем белым экраном.
   */
  ready(): Promise<void>;
  /** умеет ли клиент полноэкранный режим; нет — переключатель неактивен */
  readonly supportsFullscreen: boolean;
  /** умолчание площадки: fullscreen на телефонах, обычный на десктопе (Р15) */
  readonly defaultScreenMode: ScreenMode;
  readonly screenMode: ScreenMode;
  /** Возвращает режим, который получился: клиент вправе отказать. */
  setScreenMode(mode: ScreenMode): Promise<ScreenMode>;
  onScreenModeChange(handler: (mode: ScreenMode) => void): Unsubscribe;

  readonly insets: SafeAreaInsets;
  onInsetsChange(handler: (insets: SafeAreaInsets) => void): Unsubscribe;

  readonly viewport: ViewportState;
  onViewportChange(handler: (viewport: ViewportState) => void): Unsubscribe;
  /** развернуть приложение из компактного режима на полную высоту */
  expand(): void;

  /** `null` — кнопку спрятать. Связана со стеком экранов оболочки */
  setBackButton(handler: (() => void) | null): void;
  setSettingsButton(handler: (() => void) | null): void;

  /**
   * Вертикальные свайпы на время забега выключаются: движение пальцем вниз по
   * джойстику иначе сворачивает приложение.
   */
  setVerticalSwipesEnabled(enabled: boolean): void;
  /** подтверждение закрытия — включено в забеге, выключено в меню */
  setClosingConfirmation(enabled: boolean): void;

  readonly isActive: boolean;
  onActiveChange(handler: (active: boolean) => void): Unsubscribe;

  /**
   * Цвета шапки, фона и нижней панели — из наших токенов, а не из темы
   * площадки: игра выглядит одинаково у всех, и при открытии не мигает чужой
   * цвет (docs/27-design-system-and-app-shell.md §4.1).
   */
  applyThemeColors(colors: ThemeColors): void;
}

export interface PlatformClientInfo {
  /** клиент площадки: в Telegram — android, ios, tdesktop, macos, weba… */
  platform: string | null;
  /** версия API клиента площадки */
  version: string | null;
}

export interface InvitePayload {
  /** ссылка на игру внутри площадки */
  url: string;
  /** текст, который уйдёт вместе со ссылкой */
  text: string;
}

/** `shared` — открыт выбор чата, `copied` — ссылка в буфере, `unavailable` — не вышло ни то, ни другое. */
export type InviteResult = "shared" | "copied" | "unavailable";

export interface SharePayload {
  runScore: number;
  runDurationSec: number;
  imageUrl?: string;
}

/**
 * Хранилище «ключ — значение» на устройстве: локальный рекорд, настройки,
 * `installId` (docs/27-design-system-and-app-shell.md §7).
 *
 * Порт, а не прямой `localStorage`: на iOS он теряется вместе с данными сайта,
 * и Telegram-адаптер должен уметь переехать на `DeviceStorage` площадки, не
 * трогая ни оболочку, ни движок. Методы синхронные и ничего не бросают —
 * в приватном режиме и при переполнении реализация возвращает `null` и молча
 * пропускает запись: потерянный рекорд не стоит упавшего запуска.
 */
export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

// --- Контент как данные, см. docs/01-tech-stack.md §9 ---

/**
 * Параметры паттернов, которые крутит геймдизайнер. Всё, что не задано в
 * контенте, берётся из умолчаний паттерна в core-game.
 *
 * Расстояния и скорости — в игровых единицах, как `speed` врага; время — в
 * секундах. Ключ карты — имя паттерна: так TypeScript не даст положить врагу
 * параметр чужого паттерна, а опечатка в имени параметра видна сразу, а не
 * через молча проигнорированное значение.
 */
export interface EnemyPatternParams {
  swarm: Record<string, never>;
  chase: {
    /** насколько быстро доворачивает к игроку, доля скорости в секунду */
    steeringPerSec?: number;
  };
  kite_and_shoot: {
    /** дистанция, которую стрелок держит до игрока */
    preferredDistance?: number;
    shotIntervalSec?: number;
    projectileSpeed?: number;
  };
  dash: {
    /** с какого расстояния до игрока начинается подготовка рывка */
    triggerDistance?: number;
    /** сколько враг стоит и мигает перед рывком — время игрока на реакцию */
    telegraphSec?: number;
    dashSpeed?: number;
    dashDurationSec?: number;
    /** передышка после рывка, пока враг снова не пойдёт на игрока */
    recoverSec?: number;
  };
  orbit: {
    /** радиус кольца, на которое враг выходит вокруг игрока */
    orbitRadius?: number;
    /** на сколько кольцо сужается за секунду */
    shrinkPerSec?: number;
    /** радиус, дальше которого кольцо не сужается; 0 — до касания */
    minRadius?: number;
  };
  exploder: {
    /** с какого расстояния до игрока загорается фитиль */
    triggerDistance?: number;
    fuseSec?: number;
    blastRadius?: number;
  };
  splitter: {
    /**
     * На кого распадается при смерти. Список, а не один тип: матрёшка
     * рассыпается разными тварями, и каждая следующая ступень — свой бой, а не
     * та же толпа помельче.
     *
     * Потомок сам может быть делящимся, но цепочка обязана кончаться: глубина
     * ограничена, а кольцо «А делится на Б, Б делится на А» запрещено — иначе
     * один выстрел множит популяцию до конца пула.
     */
    children: { enemy: string; count?: number }[];
  };
  caster: {
    /** дистанция, которую кастер держит до игрока */
    preferredDistance?: number;
    /** пауза между кастами в первой фазе боя; дальше он бьёт чаще */
    castIntervalSec?: number;
    /** сколько он стоит и светится перед кастом — время игрока уйти с линии */
    telegraphSec?: number;
    /** сколько шаров в кольце и в стене на первой фазе */
    burstCount?: number;
    projectileSpeed?: number;
  };
  rush: {
    /**
     * На сколько секунд хода игрока рой берёт упреждение: он целится не туда,
     * где игрок сейчас, а туда, где тот окажется. Ноль — бежит в текущую
     * точку и почти всегда проходит за спиной.
     */
    leadSec?: number;
    /**
     * Сколько рой бежит по прямой, прежде чем снова прицелиться. Он не
     * преследует: пробежал — и уносится дальше, пока не зайдёт на новый круг.
     */
    runSec?: number;
  };
}

export type EnemyPattern = keyof EnemyPatternParams;

/**
 * Опрос обратной связи (docs/29-admin-panel.md §6). Список общий для клиента
 * и сервера: клиент рисует по нему кнопки и берёт тексты по ключам, сервер
 * проверяет, что пришло ровно это. Свободный текст — отдельным полем.
 *
 * Вопросов немного и они короткие: длинная анкета в игре не заполняется.
 */
export const FEEDBACK_QUESTIONS = [
  { id: "difficulty", options: ["easy", "fine", "hard"] },
  { id: "liked", options: ["fight", "upgrades", "look", "nothing"] },
  { id: "keepPlaying", options: ["yes", "maybe", "no"] },
] as const;

export type FeedbackQuestionId = (typeof FEEDBACK_QUESTIONS)[number]["id"];

/** Ответы: вопрос → выбранный вариант. Пропущенный вопрос просто отсутствует. */
export type FeedbackAnswers = Partial<Record<FeedbackQuestionId, string>>;

/** Потолок свободного текста: столько же, сколько держит колонка в базе. */
export const FEEDBACK_TEXT_MAX = 2000;

export type EnemyRank = "elite" | "boss";

/**
 * Стихии урона (docs/35-stage4-plan.md, §3.3, Р24): четыре поверх
 * физического. Новая стихия — строка здесь и одно состояние в
 * `core-game/src/game/sim/elements.ts`, без правки остального.
 */
export const ELEMENTS = ["physical", "fire", "cold", "lightning", "poison"] as const;

export type ElementId = (typeof ELEMENTS)[number];

/** Стихии, у которых есть состояние и сопротивление, — всё, кроме физического. */
export type StatusElement = Exclude<ElementId, "physical">;

interface EnemyDefBase {
  id: string;
  hp: number;
  speed: number;
  /** урон касанием, взрывом или снарядом — в зависимости от паттерна */
  damage: number;
  /** опыт за убийство: кристалл такой ценности остаётся на месте смерти */
  xp: number;
  /**
   * Стоимость угрозы: сколько «бюджета» отрезка таймлайна съедает один такой
   * враг. Директор спавна выпускает столько врагов, сколько влезает в бюджет,
   * поэтому дорогой враг приходит реже дешёвого при той же сложности.
   *
   * Не задана — считается по формуле из hp, урона и скорости
   * (`defaultThreat` в core-game): новому врагу не нужно сразу знать про
   * бюджет, а когда умолчание не устроило — число ставится руками.
   */
  threat?: number;
  /**
   * Ранг врага. Не задан — обычный.
   *
   * Ранг, а не свободный размер: радиус — свойство поведения, контент лишь
   * выбирает ступень. Элита крупнее и светлее обычного врага — неотличимые на
   * глаз танк и элитный танк читаются как дефект. Босс крупнее элиты, и у него
   * на экране висит полоса здоровья: бой с ним — отдельное событие забега, а не
   * очередной крепкий враг в толпе.
   *
   * И элита, и босс приходят **только событием** таймлайна в назначенную
   * минуту и в обычный поток не попадают.
   */
  rank?: EnemyRank;
  /**
   * Сопротивление стихиям — доля урона, которую враг гасит: 0.5 — вдвое
   * меньше урона, −0.5 — в полтора раза больше. Не задано — ноль. Стихийное
   * оружие должно быть ощутимо сильнее против уязвимого врага и слабее
   * против стойкого: на этом держится сборка против конкретных врагов.
   * Физическому сопротивления нет — его роль играет здоровье.
   */
  resist?: Partial<Record<StatusElement, number>>;
  /**
   * Стихия атаки врага — касания, взрыва, снаряда, удара кастера
   * (docs/35-stage4-plan.md §3.3). Не задана — физическая. Стихийную атаку
   * гасит сопротивление игрока этой стихии, и она накладывает на игрока
   * состояние: горение, холод, шок или яд.
   */
  element?: StatusElement;
  /** шанс наложить состояние за попадание, от 0 до 1; не задан — каждое попадание */
  statusChance?: number;
}

/**
 * Параметры обязательны только там, где у паттерна нет разумного умолчания:
 * делящемуся врагу не из чего выбрать, на кого распадаться.
 */
type EnemyDefFor<P extends EnemyPattern> = EnemyDefBase & { pattern: P } & (
    {} extends EnemyPatternParams[P]
      ? { params?: EnemyPatternParams[P] }
      : { params: EnemyPatternParams[P] }
  );

export type EnemyDef = { [P in EnemyPattern]: EnemyDefFor<P> }[EnemyPattern];

/**
 * Стейдж врага: та же тварь, но матёрее. Стейджи открываются по ходу забега и
 * применяются ко всем обычным врагам сразу, а не заводятся отдельным типом на
 * каждую ступень: иначе гайдбук и таймлайн распухли бы втрое, а игрок увидел
 * бы «ещё одного врага» вместо «этого же, но злее».
 *
 * Открывшийся стейдж **не вытесняет** прежние: в потоке идут все открытые, по
 * весам. Игрок должен видеть разницу между первой крысой и той, что приходит
 * на шестой минуте, и при этом узнавать обеих.
 */
export interface EnemyStageDef {
  /** с какой секунды забега стейдж начинает приходить в потоке */
  fromSec: number;
  /** доля стейджа в потоке среди открытых — относительная, не проценты */
  weight: number;
  hpMul: number;
  damageMul: number;
  speedMul: number;
  /** множитель опыта: матёрый враг обязан и качать лучше, иначе его незачем убивать */
  xpMul: number;
  /**
   * Имя ступени для игрока — ключ i18n. Первая ступень имени не имеет: это
   * обычный враг, и называть его «обычным» в гайдбуке незачем.
   */
  nameKey?: string;
}

// --- Карта: границы мира и камера, см. docs/26-stage2-plan.md, WP4.2 и WP4.3 ---

/**
 * Границы карты. Каждая ось необязательна: карта бывает ограничена по ширине,
 * по высоте, по обеим осям или бесконечна по обеим (решение Р3). Значение —
 * половина размера карты в игровых единицах в каждую сторону от центра, где
 * игрок начинает забег.
 */
export interface MapBoundsDef {
  halfWidth?: number;
  halfHeight?: number;
}

/**
 * Динамическая камера. Видимая область задаётся **площадью**, а не шириной и
 * высотой: портрет и ландшафт обязаны видеть одинаковый объём мира разной
 * формы (решение Р14), иначе телефон в ландшафте получает преимущество, а
 * широкий монитор — тем более.
 *
 * Камера — только рендер. Симуляция о масштабе не знает; от этих чисел она
 * берёт лишь радиус кольца спавна, и берёт его от **максимальной** видимой
 * области, одинаковой на всех устройствах.
 */
export interface MapCameraDef {
  /** сколько игровых единиц² видно в движении — дальний масштаб */
  viewAreaMoving: number;
  /** сколько видно на остановке — ближний масштаб */
  viewAreaIdle: number;
  /** предельное соотношение сторон видимой области */
  maxAspect: number;
  /** постоянная времени следования за игроком, с */
  followSmoothingSec: number;
  /** постоянная времени перехода масштаба, с */
  zoomSmoothingSec: number;
  /**
   * Задержка перед приближением. Короткая остановка при уклонении не должна
   * дёргать камеру; отдаление, наоборот, мгновенное — игроку нужно видеть,
   * куда он бежит.
   */
  zoomInDelaySec: number;
}

export interface MapDef {
  id: string;
  nameKey: string;
  /** не задано — мир бесконечен по обеим осям */
  bounds?: MapBoundsDef;
  camera: MapCameraDef;
}

// --- Таймлайн спавна, см. docs/26-stage2-plan.md, WP4.4 ---
// Не «волны с паузами», а непрерывный поток: отрезок таймлайна задаёт состав
// врагов, темп спавна и потолок живых. В аналитике отрезок называется волной
// (`wave_reached`), смысл термина уточнён (docs/22-analytics-and-metrics.md §5.3).

/** Непрерывный спавн одного типа врага на отрезке. */
export interface TimelineSpawnDef {
  enemy: string;
  /** врагов в секунду — поток, а не разовая волна */
  perSec?: number;
  /** разовый выброс в начале отрезка */
  burst?: number;
}

/**
 * Событие отрезка: `ring` окружает игрока кольцом, `flank` выбрасывает рой с
 * одной стороны. И то, и другое появляется за пределами видимой области.
 */
export type TimelineEventKind = "ring" | "flank";

export interface TimelineEventDef {
  kind: TimelineEventKind;
  enemy: string;
  count: number;
}

export interface TimelineSegmentDef {
  /** секунда начала отрезка */
  fromSec: number;
  /** потолок живых врагов; не задан — берётся из кривой бесконечного режима */
  maxAlive?: number;
  spawns: TimelineSpawnDef[];
  events?: TimelineEventDef[];
}

/** Событие генерируемой части таймлайна: повторяется раз в N отрезков. */
export interface EndlessEventDef {
  everySegments: number;
  kind: TimelineEventKind;
  enemy: string;
  count: number;
}

/**
 * Кривая бесконечного режима: чем продолжается таймлайн после последнего
 * отрезка, расписанного руками. Параметры, а не сто строк данных — забег не
 * кончается, а расписывать его руками до бесконечности нельзя.
 */
export interface EndlessCurveDef {
  /** с какой секунды отрезки генерируются вместо ручных */
  fromSec: number;
  /** длительность одного генерируемого отрезка */
  segmentSec: number;
  /** бюджет угрозы в секунду на первом генерируемом отрезке */
  threatPerSec: number;
  /** во сколько раз растёт бюджет угрозы за отрезок */
  threatGrowth: number;
  /**
   * Потолок живых врагов. Упёрлись — дальше сложность растёт не числом, а
   * здоровьем и уроном: число врагов на экране ограничено производительностью
   * (docs/25-week1-fps-trials.md §6.5).
   */
  maxAlive: number;
  /** множитель здоровья врагов за отрезок */
  hpGrowth: number;
  /** множитель урона врагов за отрезок */
  damageGrowth: number;
  /** порядок ввода типов врагов, от простых к сложным */
  pool: string[];
  /** сколько типов из пула доступно на первом генерируемом отрезке */
  startTypes: number;
  /** на сколько типов пул расширяется за отрезок */
  typesPerSegment: number;
  /** сколько типов идёт одновременно: комбинации паттернов, а не один тип */
  mixSize: number;
  events: EndlessEventDef[];
}

// --- Оружие, пассивки и прокачка внутри забега ---
// Персонаж атакует постоянно; вид атаки задаёт оружие, силу — его уровень и
// пассивки. Новое поведение — код, новое оружие на готовом поведении и все
// числа — данные (docs/26-stage2-plan.md, WP2).

export type WeaponBehavior =
  | "projectile_nearest"
  | "projectile_facing"
  | "orbit"
  | "aura"
  | "area_strike";

/**
 * Числа оружия на одном уровне. Что именно значит поле, зависит от поведения:
 * у зоны урона `cooldownSec` — период тика, у снаряда — перезарядка.
 * Незаданное поле поведение берёт из своих умолчаний.
 */
export interface WeaponLevel {
  damage: number;
  cooldownSec: number;
  /** снарядов или орбитеров за срабатывание */
  projectiles?: number;
  /** сколько врагов пробивает снаряд, прежде чем исчезнуть */
  pierce?: number;
  /** радиус зоны: аура, удар по площади, орбита */
  areaRadius?: number;
  projectileSpeed?: number;
  /** время жизни снаряда или зоны */
  ttlSec?: number;
  /** шанс наложить состояние своей стихии за попадание, от 0 до 1 */
  statusChance?: number;
}

export interface WeaponDef {
  id: string;
  behavior: WeaponBehavior;
  nameKey: string;
  descriptionKey: string;
  /** можно выбрать на старте забега */
  starting?: boolean;
  /** вес в выборе улучшений; по умолчанию 1 */
  weight?: number;
  /** стихия урона; не задана — физический */
  element?: ElementId;
  /** уровни по порядку: levels[0] — первый уровень */
  levels: WeaponLevel[];
}

/**
 * Параметры, которые снаряжение, дерево и бусты меняют на весь забег
 * (docs/35-stage4-plan.md §3.3, WP7). Движок получает их готовым набором и не
 * знает про предметы: снаряжение — понятие экономики, а не боя.
 *
 * Значение — прибавка, и её смысл зависит от параметра:
 * - `damage`, `area`, `projectileSpeed`, `duration`, `moveSpeed`,
 *   `pickupRadius`, урон стихии `damageFire` … `damagePoison` и
 *   `statusChance` — к множителю: `0.12` — это +12%;
 * - `cooldown` — ускорение: `0.05` — перезарядка на 5% короче;
 * - `maxHp`, `regenPerSec`, `armor` — числом: `20` — +20 здоровья;
 * - `resistFire` … `resistPoison` — доля сопротивления: `0.1` — +10%.
 */
export const LOADOUT_STATS = [
  "damage",
  "cooldown",
  "area",
  "projectileSpeed",
  "duration",
  "moveSpeed",
  "pickupRadius",
  "maxHp",
  "regenPerSec",
  "armor",
  "resistFire",
  "resistCold",
  "resistLightning",
  "resistPoison",
  "damageFire",
  "damageCold",
  "damageLightning",
  "damagePoison",
  "statusChance",
] as const;

export type LoadoutStat = (typeof LOADOUT_STATS)[number];

/**
 * Набор на забег: модификаторы параметров и активные бусты. Пишется в запись
 * и снимок забега — иначе повтор и продолженный забег разошлись бы с
 * оригиналом. Пустой набор — забег без снаряжения.
 */
export interface RunLoadout {
  modifiers: Partial<Record<LoadoutStat, number>>;
  /** id активных бустов; движок их пока только записывает (WP8) */
  boosts: string[];
}

/** Характеристики игрока, которые меняют пассивки. */
export type PlayerStat =
  | "damage"
  | "cooldown"
  | "area"
  | "projectileSpeed"
  | "duration"
  | "projectiles"
  | "moveSpeed"
  | "maxHp"
  | "regenPerSec"
  | "pickupRadius"
  | "armor"
  /** сопротивление всем стихиям сразу — доля урона, которую гасит игрок */
  | "resist"
  | "resistFire"
  | "resistCold"
  | "resistLightning"
  | "resistPoison";

/**
 * Пассивное улучшение. `levels` — итоговое значение на каждом уровне, а не
 * прибавка к предыдущему: так в таблице сразу видно, что даёт третий уровень,
 * и нельзя случайно получить произведение прибавок.
 */
/**
 * Категория пассивки. У каждой категории свои слоты: игрок выбирает, чем
 * жертвует, и к десятой минуте не собирает всё сразу.
 */
export type PassiveCategory = "attack" | "defense" | "mobility";

export const PASSIVE_CATEGORIES: readonly PassiveCategory[] = ["attack", "defense", "mobility"];

export interface PassiveDef {
  id: string;
  nameKey: string;
  descriptionKey: string;
  /** в слот какой категории встаёт пассивка */
  category: PassiveCategory;
  stat: PlayerStat;
  /** `mul` — множитель (1.1 это +10%), `add` — слагаемое */
  op: "add" | "mul";
  weight?: number;
  levels: number[];
}

/**
 * Что остаётся после убитого врага. Данные геймдизайнера
 * (`core-game/src/content/drops.ts`).
 */
/**
 * Второй шанс — продолжение забега после смерти
 * (docs/07-monetization-and-ads.md §8). Числа решает геймдизайнер
 * (docs/34-stage3-plan.md, О1); проверку диапазонов делает тест контента.
 */
export interface ContinueDef {
  /** сколько продолжений за забег; 0 — второго шанса нет */
  perRun: number;
  /** сколько здоровья возвращается: доля максимального, больше 0 и не больше 1 */
  restoreHpRatio: number;
  /**
   * Сколько секунд после возврата игрока нельзя ранить. Врагов на поле к этому
   * моменту нет, но новые подходят с кольца спавна, а снаряды летят с края
   * экрана — без неуязвимости игрок умирал бы, не успев сориентироваться.
   */
  invulnerableSec: number;
}

export interface DropsDef {
  gems: {
    /**
     * На сколько кристаллов максимум делится опыт одного врага. Сумма опыта
     * от этого не меняется — меняется только, сколько кристаллов разлетится.
     * 1 — всегда один кристалл.
     */
    maxPerKill: number;
  };
  medkits: {
    /** шанс аптечки с рядового врага, от 0 до 1 */
    chance: number;
    /** шанс с элиты: элита — контрольная точка, и награда за неё должна чувствоваться */
    eliteChance: number;
    /** сколько лечит: доля максимального здоровья, больше 0 и не больше 1 */
    healRatio: number;
    /** больше этого на поле не лежит — новые не падают, пока игрок не подберёт */
    maxOnField: number;
  };
  /** магнит: подобранный, притягивает к игроку все кристаллы на поле */
  magnets: {
    chance: number;
    eliteChance: number;
    maxOnField: number;
  };
  /**
   * динамит: подобранный, взрывается вокруг игрока — рядовых врагов в радиусе
   * убивает, элите снимает долю здоровья, но не убивает
   */
  dynamite: {
    chance: number;
    eliteChance: number;
    maxOnField: number;
    /** радиус взрыва в игровых единицах */
    radiusUnits: number;
    /** доля базового здоровья элиты, которую снимает взрыв; меньше 1 */
    eliteHpRatio: number;
  };
}

/**
 * Уровень сложности забега. Выбирается перед забегом; рекорд и лидерборд
 * ведутся по каждому отдельно — время на «Сложной» и на «Лёгкой» несравнимо.
 */
export type DifficultyId = "easy" | "normal" | "hard";

export const DIFFICULTY_IDS: readonly DifficultyId[] = ["easy", "normal", "hard"];

/**
 * Во сколько раз сложность меняет врагов и темп. Единицы — таймлайн как в
 * контенте; множители ложатся поверх кривой сложности, а не вместо неё.
 */
export interface DifficultyDef {
  id: DifficultyId;
  nameKey: string;
  descriptionKey: string;
  /** здоровье врагов */
  enemyHpMul: number;
  /** урон врагов: касание, взрыв, снаряд */
  enemyDamageMul: number;
  /** темп спавна — врагов в секунду */
  spawnRateMul: number;
  /** потолок живых врагов одновременно */
  maxAliveMul: number;
}

/** Сколько оружий и пассивок каждой категории игрок держит одновременно. */
export interface LoadoutLimits {
  weapons: number;
  passives: Record<PassiveCategory, number>;
}

/**
 * Кривая опыта: сколько нужно на уровень N. Задаётся формулой, а не таблицей
 * на сто строк, — геймдизайнеру нужно крутить темп, а не каждое число.
 */
export interface LevelCurveDef {
  /** опыт на второй уровень */
  baseXp: number;
  /** во сколько раз дороже следующий уровень */
  growth: number;
}

export type UpgradeOptionKind =
  | "weapon_new"
  | "weapon_level"
  | "passive_new"
  | "passive_level"
  | "heal";

/**
 * Вариант выбора при наборе уровня. `id` устойчив между прогонами — именно он
 * пишется в лог ввода, чтобы забег воспроизводился (docs/28-diagnostics.md §3.4).
 */
export interface UpgradeOption {
  id: string;
  kind: UpgradeOptionKind;
  /** id оружия или пассивки; для лечения — пустая строка */
  refId: string;
  /** уровень, который игрок получит, выбрав вариант */
  level: number;
  nameKey: string;
  descriptionKey: string;
  /**
   * Что именно даёт вариант — по строке на характеристику. Без этого «Искра,
   * уровень 3» ничего не говорит: больше снарядов, быстрее или сильнее? Для
   * нового оружия — его главные числа, для уровня — только то, что меняется.
   */
  changes: UpgradeChange[];
}

/** Как показывать число изменения. */
export type UpgradeChangeFormat =
  /** как есть: урон 6 → 7, снарядов 1 → 2 */
  | "value"
  /** множитель как процент: 1.1 → «+10%», 0.92 → «−8%» */
  | "percent"
  /** прибавка со знаком: «+20» */
  | "plus";

export interface UpgradeChange {
  /** ключ i18n подписи характеристики */
  labelKey: string;
  /** было; `null` — у нового оружия или пассивки, сравнивать не с чем */
  from: number | null;
  to: number;
  format: UpgradeChangeFormat;
  /** меньше — лучше (перезарядка): интерфейс красит улучшение, а не рост числа */
  lowerIsBetter: boolean;
}

// --- Итог забега, см. docs/26-stage2-plan.md, WP3 ---
// Движок считает и отдаёт, оболочка показывает на экране смерти и отправляет
// событием `run_finished` / `run_abandoned`. Сам движок в сеть не ходит и об
// аналитике не знает (docs/27-design-system-and-app-shell.md §3.1).
//
// Считает это всё клиент, поэтому для сервера `RunResult` — заявление игрока,
// а не факт (docs/15-engineering-standards.md §7.1). Приёмник телеметрии
// (WP8) обязан относиться к нему так же: для аналитики закрытого теста этого
// достаточно, для лидерборда этапа 4 — нет, там нужна перепроверка забега по
// seed'у и логу ввода (docs/17-testing-strategy.md §3.5).

/** Чем закончился забег: смертью или сдачей на экране паузы. */
export type RunOutcome = "died" | "abandoned";

export interface RunWeaponSummary {
  id: string;
  level: number;
  /** нанесённый урон — главный вход геймдизайнера для баланса оружий */
  damage: number;
}

export interface RunPassiveSummary {
  id: string;
  level: number;
}

export interface RunResult {
  runId: string;
  /** seed забега: с ним и логом ввода забег воспроизводится целиком */
  seed: number;
  outcome: RunOutcome;
  startingWeaponId: string;
  /** карта забега: на старте она одна, но разрез в аналитике нужен сразу */
  mapId: string;
  /** уровень сложности: рекорд и лидерборд — отдельно по каждому */
  difficultyId: DifficultyId;
  /**
   * Отпечаток игрового контента. Без него правку баланса не отделить от
   * сезонности: два забега с разной длиной могут отличаться и игроком, и
   * версией чисел (docs/22-analytics-and-metrics.md §5.3).
   */
  contentHash: string;
  /**
   * Отрезок таймлайна спавна, до которого дожил игрок. В аналитике это
   * «волна» (`wave_reached`) — распределение по ней показывает, где кривая
   * сложности режет.
   */
  waveReached: number;
  /** главный показатель забега (Р2) и будущая метрика лидерборда */
  survivalSec: number;
  level: number;
  xpCollected: number;
  enemiesKilled: number;
  /** убийства по id врага; враги без убийств не попадают */
  killsByEnemy: Record<string, number>;
  damageDealt: number;
  damageTaken: number;
  /**
   * Урон по стихиям (docs/35-stage4-plan.md, WP6, «Аналитика»): физическим и
   * каждой стихией, считая горение, яд и перескок молнии. Стихии без урона
   * не попадают — как враги без убийств в `killsByEnemy`.
   */
  damageByElement: Partial<Record<ElementId, number>>;
  weapons: RunWeaponSummary[];
  passives: RunPassiveSummary[];
  /** id врага, нанёсшего смертельный урон; null — забег кончился не смертью */
  deathCause: string | null;
  /** пройденное расстояние в игровых единицах — показатель стиля игры */
  distance: number;
  /** пик числа врагов одновременно в мире */
  peakEnemies: number;
  /**
   * В забеге включали читы режима разработчика. Такой забег не идёт в рекорд
   * устройства и в рейтинг, пока администратор явно не попросит
   * (docs/26-stage2-plan.md, WP14).
   */
  cheats: boolean;
  /**
   * Секунды забега, на которых игрок продолжил после смерти (второй шанс,
   * docs/07-monetization-and-ads.md §8); пусто — не продолжал. Сервер сверяет
   * их с покупками: продолжение без оплаты — подозрительный забег.
   */
  continues: number[];
}

// --- Забеги под аккаунтом: старт, итог, рейтинг (docs/34-stage3-plan.md, WP4) ---
//
// Контракт клиента с модулем забегов бэкенда. Сервер проверяет тело своей
// схемой; здесь — форма, на которую опирается оболочка. Идентификаторы других
// аккаунтов наружу не отдаются: строка лидерборда знает только, «моя» ли она.

/**
 * Старт забега. Уходит в очередь в начале забега — не на горячем пути: по нему
 * сервер ставит своё время начала и сверяет с ним длительность итога.
 */
export interface RunStartSubmission {
  runId: string;
  difficultyId: DifficultyId;
  startingWeaponId: string;
  contentHash: string;
  /** сколько секунд прошло от начала забега до отправки: старт мог ждать сеть */
  elapsedSec: number;
}

export interface RunFinishSubmission {
  /** повтор с тем же `runId` не удваивает статистику */
  runId: string;
  difficultyId: DifficultyId;
  outcome: RunOutcome;
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  startingWeaponId: string;
  weapons: { id: string; level: number }[];
  contentHash: string;
  /**
   * id врага, нанёсшего смертельный урон; `null` — сдача. Для сводки «кто чаще
   * убивает». Необязательно: забег в очереди от прошлой сборки поля не знает.
   */
  deathCause?: string | null;
  /** забег в режиме разработчика с читами — в рейтинг и статистику не идёт */
  cheats?: boolean;
  /** администратор просит учесть забег с читами в рейтинге — для проверки рейтинга */
  countInRating?: boolean;
  /**
   * Секунда каждого второго шанса: сервер сверяет их с покупками
   * (docs/34-stage3-plan.md, WP5). Необязательно: забег в очереди от прошлой
   * сборки поля не знает.
   */
  continues?: number[];
}

/**
 * Запуск приложения — для статистики плейтеста: сколько людей открыли игру
 * и на чём. Технические сведения об устройстве без идентификаторов, кроме
 * `installId`, который уже есть у каждой установки (docs/28-diagnostics.md §5.2).
 */
export interface PlaytestSessionReport {
  installId: string;
  build: string;
  contentHash: string;
  device: PlaytestDevice;
}

export type DeviceOs = "android" | "ios" | "windows" | "macos" | "linux" | "other";
export type DeviceFormFactor = "phone" | "tablet" | "desktop";

export interface PlaytestDevice {
  clientPlatform: string | null;
  clientVersion: string | null;
  os: DeviceOs;
  formFactor: DeviceFormFactor;
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
  cores: number | null;
  memoryGb: number | null;
}

/**
 * Что решил антифрод: `ok` — прошёл проверки, `suspicious` — сохранён, но не в
 * рейтинге до разбора, `rejected` — невозможный забег.
 */
export type RunVerdict = "ok" | "suspicious" | "rejected";

export interface RunFinishResult {
  /** лучшее время игрока на этой сложности после забега */
  bestSurvivalSec: number;
  isNewBest: boolean;
  /** место в лидерборде сложности, с единицы */
  rank: number | null;
  /** `false` — забег не в рейтинге: читы или вердикт не `ok` */
  recorded: boolean;
  verdict: RunVerdict;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  photoUrl: string | null;
  survivalSec: number;
  level: number;
  startingWeaponId: string;
  enemiesKilled: number;
  isMe: boolean;
}

export interface Leaderboard {
  difficultyId: DifficultyId;
  entries: LeaderboardEntry[];
  /** своё место, даже если оно ниже показанных строк */
  me: { rank: number; survivalSec: number } | null;
  totalPlayers: number;
}

export interface RecentRun {
  difficultyId: DifficultyId;
  survivalSec: number;
  level: number;
  startingWeaponId: string;
  /** когда получен сервером, мс UTC */
  at: number;
}

/**
 * Что игроку открыто в клиенте. Решает сервер по праву аккаунта; скрытая
 * кнопка — не защита, и то, что трогает чужие данные, сервер проверяет сам.
 */
export interface PlaytestAccess {
  admin: boolean;
  stressTest: boolean;
  devMode: boolean;
}

export interface RunProfile {
  runs: number;
  totalKills: number;
  totalSurvivalSec: number;
  best: Record<DifficultyId, { survivalSec: number; rank: number } | null>;
  recent: RecentRun[];
}

// --- Экономика / SKU, см. docs/05-game-design.md §5, docs/07-monetization-and-ads.md ---

export interface EconomyItemDef {
  id: string;
  kind: "skin" | "continue" | "character_unlock" | "ad_removal_pack" | "seasonal";
  priceByPlatform: Partial<Record<Platform, number>>;
}

export { createNoopPlatformUi } from "./platform-ui-noop";
