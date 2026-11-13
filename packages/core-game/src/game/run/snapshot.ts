import type { RunHuntEntry } from "@bh/shared-types";
import type { RunProofDraft } from "../../run-api";
import { decodeInputLog, INPUT_LOG_ENCODING, InputLogError } from "../diagnostics/input-log";
import { captureHunt, MAX_HUNT_ENTRIES, type HuntSnapshot } from "./hunt-log";
import { MAX_CARD_TOOLS } from "../progression/card-tools";
import { CORDON_SOURCES, createCordonState, type CordonSource, type CordonState } from "../sim/cordon";
import { RUBEZH_PHASES, type RubezhPhase } from "../sim/rubezh";
import { createHazardState } from "../sim/hazards";
import { restoreBlessings } from "../sim/secrets";
import { createSiegeState, type SiegeState } from "../sim/siege";
import { SIEGE_LEVEL_CEILING } from "../sim/siege-rules";
import { stalkerGapRange, STALKER_PHASES, type StalkerPhase, type StalkerState } from "../sim/stalker";
import { resetStalkerBody, stalkerAlive, type StalkerBodyState } from "../sim/stalker-body";
import type { Spawner } from "../sim/spawner";
import { TICK_HZ, type World } from "../sim/world";

/**
 * Снимок забега: всё, что меняется по ходу игры, в виде, пригодном для
 * хранения на устройстве. По нему прерванный забег продолжается с того же
 * тика — после сворачивания, вылета или перезапуска приложения.
 *
 * Снимок, а не повтор по логу ввода: лог даёт тот же забег, но десять минут
 * симуляции на бюджетном Android пересчитываются секундами, а снимок
 * восстанавливается мгновенно. Лог остаётся за диагностикой
 * (docs/28-diagnostics.md §3.4).
 *
 * Типизированные массивы пулов идут в base64 только в занятой части
 * (`count`): за её границей слоты ни разу не использовались и совпадают с
 * только что созданным пулом. Числа при этом переносятся побитово, и
 * продолженный забег идёт ровно так же, как шёл бы без перерыва — это
 * проверяет тест.
 */

/** Меняется при любой правке формата: старый снимок тогда не читается, а не читается криво. */
export const WORLD_SNAPSHOT_VERSION = 18;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(`Снимок забега не читается: ${message}`);
    this.name = "SnapshotError";
  }
}

type TypedArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Int16Array
  | Uint32Array
  | Uint8Array;

type TypedKind = "f64" | "f32" | "i32" | "i16" | "u32" | "u8";

interface EncodedArray {
  kind: TypedKind;
  length: number;
  data: string;
}

interface EncodedPool {
  scalars: Record<string, number>;
  arrays: Record<string, EncodedArray>;
}

/** Тайник в снимке: вид нужен для сверки с раскладкой, остальное — состояние. */
interface SiteSnapshot {
  kind: string;
  x: number;
  y: number;
  active: boolean;
  visible: boolean;
  found: boolean;
  used: boolean;
  holdTicks: number;
  /** разлом Нави: волна выпущена */
  opened: boolean;
  /** разлом Нави: элиты волны, что ещё живы */
  wave: { slot: number; type: number }[];
  /** разлом Нави: сколько тиков идёт волна — отсчёт срока */
  waveTicks: number;
  /** огонёк: сделано шагов; чётность — сторона следующего отклонения */
  hops: number;
  /** огонёк: летит к точке шага */
  flying: boolean;
  /** огонёк: куда летит */
  hopX: number;
  hopY: number;
}

/**
 * Состояние тайников. Раскладка бросается при создании мира из того же seed и
 * контента, поэтому места в снимке нужны для сверки и для огонька, который
 * летит; журналы для сцены (`foundLog`, `usedLog`, `blessingLog`) не входят.
 */
interface SecretsSnapshot {
  rng: number;
  /** поток отклонений огонька */
  wispRng: number;
  sites: SiteSnapshot[];
  offer: { siteIndex: number; options: string[] } | null;
  blessings: string[];
}

/** Динамическая часть тела преследователя; окно толчков — обычным массивом чисел. */
type StalkerBodySnapshot = Omit<StalkerBodyState, "pushWindow" | "rules" | "typeIndex"> & { pushWindow: number[] };

/** Состояние осады; журнал событий для сцены (`log`) в снимок не входит. */
type SiegeSnapshot = Omit<SiegeState, "rng" | "log"> & { rng: number };

/** Состояние директора Карачуна; правила (`appear`) и журнал для сцены (`ended`) в снимок не входят. */
type StalkerSnapshot = Omit<StalkerState, "rng" | "appear" | "ended"> & { rng: number };

export interface WorldSnapshot {
  version: number;
  rng: number;
  /** поток новых карточек после переброса и изгнания */
  cardRng: number;
  player: World["player"];
  playerStats: World["playerStats"];
  playerStatsBase: World["playerStatsBase"];
  loadout: World["loadout"];
  progression: World["progression"];
  difficulty: World["difficulty"];
  /**
   * Модификатор забега (T-0119): нужен для сверки, а не для восстановления — его действие
   * мир берёт из параметров создания. В снимках без поля — забег без модификатора.
   */
  modifierIds?: readonly string[];
  gemMergeCursor: number;
  stats: EncodedPool;
  enemies: EncodedPool;
  projectiles: EncodedPool;
  gems: EncodedPool;
  pickups: EncodedPool;
  /** состояние сундуков; записи для сцены (`founds`, `openings`) не входят */
  chest: { rng: number; dropped: number; opened: number };
  /** тайники рубежа: поток, места, выбор капища и взятые благословения */
  secrets: SecretsSnapshot;
  /** кольцо стражей; в снимках прежнего формата поля нет — это «кольца нет» */
  cordon?: Omit<CordonState, "ended">;
  /**
   * Лужи врагов со следом и отсчёт следа по слотам врагов (T-0282). В снимках без поля луж нет,
   * а отсчёт идёт с нуля: версию формата не поднимали.
   */
  hazards?: { puddles: EncodedPool; trail: EncodedPool };
  /** осада стоящего: поток, якорь, счётчик, уровень, перезарядка; в снимках без поля осада начинается заново (T-0392) */
  siege?: SiegeSnapshot;
  /**
   * Тело неубиваемого преследователя: слот, окно и серия толчков, таймеры касания; правила и тип не входят
   * (мир создаётся из того же контента). В снимках без поля преследователя нет (T-0421)
   */
  stalkerBody?: StalkerBodySnapshot;
  /**
   * Директор Карачуна: поток, фаза, отметки и счётчики появления. В снимках без поля фаза — по правилам
   * нового мира, а первое предвестие — не раньше обычной паузы от секунды снимка (T-0423)
   */
  stalker?: StalkerSnapshot;
  /**
   * Рубеж: поток, фаза и секунда победы. В снимках без поля до отметки страж «ждёт»,
   * после — «пропущен»: в уже начатый забег он не вмешивается (T-0120)
   */
  rubezh?: { rng: number; phase: RubezhPhase; clearedSec: number | null };
  /**
   * Пролог: только у снимка забега в режиме `prologue` (T-0278). Снимок обычного забега
   * поля не несёт, и в мир пролога он не грузится — как и наоборот.
   */
  prologue?: { lastWardTick: number; firstOfferMade: boolean };
  /** журнал охоты; в снимках без поля — пуст, а время появления живых элит неизвестно (tasks/T-0292) */
  hunt?: HuntSnapshot;
  spawner: unknown;
}

/** Снять состояние мира и директора спавна. Мир при этом не меняется. */
export function captureWorld(world: World, spawner: Spawner): WorldSnapshot {
  return {
    version: WORLD_SNAPSHOT_VERSION,
    rng: world.rng.getState(),
    cardRng: world.cardRng.getState(),
    player: { ...world.player },
    playerStats: { ...world.playerStats },
    playerStatsBase: { ...world.playerStatsBase },
    // Набор и прогрессия — обычные объекты с вложенными массивами: копия через
    // JSON отрезает ссылки на живой мир, и дальнейший забег снимок не меняет.
    loadout: cloneJson(world.loadout),
    progression: cloneJson(world.progression),
    difficulty: { ...world.difficulty },
    ...(world.modifierIds.length === 0 ? {} : { modifierIds: [...world.modifierIds] }),
    gemMergeCursor: world.gemMergeCursor,
    stats: encodeRecord(world.stats, Number.POSITIVE_INFINITY),
    enemies: encodeRecord(world.enemies, world.enemies.count),
    projectiles: encodeRecord(world.projectiles, world.projectiles.count),
    gems: encodeRecord(world.gems, world.gems.count),
    pickups: encodeRecord(world.pickups, world.pickups.count),
    chest: { rng: world.chests.rng.getState(), dropped: world.chests.dropped, opened: world.chests.opened },
    secrets: capturedSecrets(world),
    hazards: {
      puddles: encodeRecord(world.hazards.puddles, world.hazards.puddles.alive.length),
      trail: encodeRecord(world.hazards.trail, world.enemies.count),
    },
    siege: capturedSiege(world.siege),
    stalkerBody: capturedStalkerBody(world.stalkerBody),
    stalker: capturedStalker(world.stalker),
    // Журнал закончившихся колец не входит: после восстановления он пуст, событие не повторяется.
    cordon: capturedCordon(world.cordon),
    rubezh: { rng: world.rubezh.rng.getState(), phase: world.rubezh.phase, clearedSec: world.rubezh.clearedSec },
    ...(world.prologue === null
      ? {}
      : { prologue: { lastWardTick: world.prologue.lastWardTick, firstOfferMade: world.prologue.firstOfferMade } }),
    hunt: captureHunt(world),
    spawner: spawner.saveState?.() ?? null,
  };
}

/**
 * Перенести снимок в мир, только что созданный из того же контента и с теми
 * же параметрами. Снимок пришёл из хранилища устройства, поэтому форма
 * проверяется: битый снимок бросает `SnapshotError`, а не рождает мир с
 * `NaN` в координатах.
 */
export function restoreWorld(world: World, spawner: Spawner, input: unknown): void {
  const snapshot = asRecord(input, "снимок");
  if (snapshot.version !== WORLD_SNAPSHOT_VERSION) {
    throw new SnapshotError(`версия ${String(snapshot.version)}, ожидалась ${WORLD_SNAPSHOT_VERSION}`);
  }

  checkModifiers(world, snapshot.modifierIds);

  world.rng.setState(asNumber(snapshot.rng, "rng"));
  world.cardRng.setState(asNumber(snapshot.cardRng, "cardRng"));
  // Снимок до отброса преследователя полей отброса не знает: игрок стоит, а не ошибка чтения.
  assignNumbers(world.player, { knockbackTicks: 0, knockbackVx: 0, knockbackVy: 0, ...asRecord(snapshot.player, "player") }, "player");
  world.player.alive = asBoolean(asRecord(snapshot.player, "player").alive, "player.alive");
  assignNumbers(world.playerStats, snapshot.playerStats, "playerStats");
  assignNumbers(world.playerStatsBase, snapshot.playerStatsBase, "playerStatsBase");
  world.loadout = restoreLoadout(world, snapshot.loadout);
  world.progression = restoreProgression(snapshot.progression, world.limitTypes.length);
  assignNumbers(world.difficulty, snapshot.difficulty, "difficulty");
  world.gemMergeCursor = asNumber(snapshot.gemMergeCursor, "gemMergeCursor");

  decodeRecord(world.stats, snapshot.stats, "stats");
  decodeRecord(world.enemies, snapshot.enemies, "enemies");
  decodeRecord(world.projectiles, snapshot.projectiles, "projectiles");
  decodeRecord(world.gems, snapshot.gems, "gems");
  decodeRecord(world.pickups, snapshot.pickups, "pickups");

  const chest = asRecord(snapshot.chest, "chest");
  world.chests.rng.setState(asNumber(chest.rng, "chest.rng"));
  world.chests.dropped = asNumber(chest.dropped, "chest.dropped");
  world.chests.opened = asNumber(chest.opened, "chest.opened");
  world.chests.founds = [];
  world.chests.openings = [];
  restoreCordon(world, snapshot.cordon);
  restoreRubezh(world, snapshot.rubezh);
  restorePrologue(world, snapshot.prologue);
  restoreHunt(world, snapshot.hunt);
  restoreSecrets(world, snapshot.secrets);
  restoreSiege(world, snapshot.siege);
  restoreHazards(world, snapshot.hazards);
  restoreStalkerBody(world, snapshot.stalkerBody);
  restoreStalker(world, snapshot.stalker);

  if (snapshot.spawner !== null) spawner.loadState?.(snapshot.spawner);
  // События — только для рендера: новый рендер начинает с чистого буфера.
  world.events.written = 0;
}

/**
 * Модификатор снимка обязан совпасть с модификатором мира, в который он ложится: оси
 * сложности берутся из параметров создания, и снимок «Спешки» в мир без неё продолжил бы
 * другой забег с тем же номером.
 */
function checkModifiers(world: World, input: unknown): void {
  const saved = input === undefined ? [] : asArray(input, "modifierIds").map((id, i) => asString(id, `modifierIds[${i}]`));
  if (saved.length !== world.modifierIds.length || saved.some((id, i) => id !== world.modifierIds[i])) {
    const name = (ids: readonly string[]): string => (ids.length === 0 ? "без модификатора" : ids.join(", "));
    throw new SnapshotError(`модификатор забега: в снимке ${name(saved)}, в мире ${name(world.modifierIds)}`);
  }
}

/** Потолки записи для проверки из снимка: страховка от битых данных, а не правила игры. */
const MAX_PROOF_CHOICES = 4_000;
const MAX_PROOF_CONTINUES = 64;
const MAX_PROOF_CHECKPOINTS = 720;
const MAX_PROOF_OPTION_ID = 64;

/**
 * Запись для проверки из снимка прерванного забега (tasks/T-0316). Снимок пришёл из
 * хранилища устройства, поэтому форма и лог ввода проверяются, а не приводятся: годную
 * запись продолженный забег дописывает дальше. Нет записи (снимок прошлой сборки, забег
 * разработчика) или она битая — `null`, и забег не повторить с начала. Битая запись
 * продолжению не мешает: проверка нужна серверу, а не игроку.
 */
export function readProofDraft(input: unknown): RunProofDraft | null {
  if (input === undefined) return null;
  try {
    const record = asRecord(input, "proof");
    const unitScale = asNumber(record.unitScale, "proof.unitScale");
    if (!Number.isFinite(unitScale) || unitScale <= 0) throw new SnapshotError("proof.unitScale: ожидалось положительное число");
    const startingWeaponId = asString(record.startingWeaponId, "proof.startingWeaponId");
    if (startingWeaponId.length > MAX_PROOF_OPTION_ID) throw new SnapshotError("proof.startingWeaponId: слишком длинный id");
    const log = asRecord(record.input, "proof.input");
    const ticks = asCount(log.ticks, "proof.input.ticks");
    const data = asString(log.data, "proof.input.data");
    const truncated = asBoolean(log.truncated, "proof.input.truncated");
    if (log.encoding !== INPUT_LOG_ENCODING) throw new SnapshotError("proof.input.encoding: незнакомая кодировка");
    const encoded = { encoding: INPUT_LOG_ENCODING, ticks, data, truncated } as const;
    // Лог читается целиком: битый не дописать, а продолжение поверх него дало бы запись с мусором в начале.
    if (!truncated) decodeInputLog(encoded);
    const choices = asArray(record.choices, "proof.choices");
    if (choices.length > MAX_PROOF_CHOICES) throw new SnapshotError("proof.choices: слишком много выборов");
    const continues = asArray(record.continues, "proof.continues");
    if (continues.length > MAX_PROOF_CONTINUES) throw new SnapshotError("proof.continues: слишком много продолжений");
    const checkpoints = asArray(record.checkpoints, "proof.checkpoints");
    if (checkpoints.length > MAX_PROOF_CHECKPOINTS) throw new SnapshotError("proof.checkpoints: слишком много свёрток");
    return {
      unitScale,
      startingWeaponId,
      input: encoded,
      choices: choices.map((entry, index): [number, string] => {
        const pair = asArray(entry, `proof.choices[${index}]`);
        const optionId = asString(pair[1], `proof.choices[${index}][1]`);
        if (pair.length !== 2 || optionId.length > MAX_PROOF_OPTION_ID) throw new SnapshotError(`proof.choices[${index}]: не пара «тик, вариант»`);
        return [asCount(pair[0], `proof.choices[${index}][0]`), optionId];
      }),
      continues: continues.map((tick, index) => asCount(tick, `proof.continues[${index}]`)),
      checkpoints: checkpoints.map((entry, index): [number, number] => {
        const pair = asArray(entry, `proof.checkpoints[${index}]`);
        const checksum = asNumber(pair[1], `proof.checkpoints[${index}][1]`);
        if (pair.length !== 2 || !Number.isInteger(checksum)) throw new SnapshotError(`proof.checkpoints[${index}]: не пара «тик, свёртка»`);
        return [asCount(pair[0], `proof.checkpoints[${index}][0]`), checksum];
      }),
    };
  } catch (error: unknown) {
    if (error instanceof SnapshotError || error instanceof InputLogError) return null;
    throw error;
  }
}

function capturedSecrets(world: World): SecretsSnapshot {
  const secrets = world.secrets;
  return {
    rng: secrets.rng.getState(),
    wispRng: secrets.wispRng.getState(),
    sites: secrets.sites.map((site) => ({
      kind: site.kind,
      x: site.x,
      y: site.y,
      active: site.active,
      visible: site.visible,
      found: site.found,
      used: site.used,
      // Отсчёт щита древа — тот же `holdTicks`: он растёт, пока игрок в круге.
      holdTicks: site.holdTicks,
      opened: site.opened,
      wave: site.wave.map((entry) => ({ slot: entry.slot, type: entry.type })),
      waveTicks: site.waveTicks,
      hops: site.hops,
      flying: site.flying,
      hopX: site.hopX,
      hopY: site.hopY,
    })),
    offer: secrets.offer === null ? null : { siteIndex: secrets.offer.siteIndex, options: [...secrets.offer.options] },
    blessings: [...secrets.blessings],
  };
}

/**
 * Тайники. Раскладка уже брошена при создании мира, поэтому снимок обязан с
 * ней сойтись: другое число мест или вид — снимок другого контента, а не
 * повод молча поставить игрока на чужую карту. Поле обязательное: версию
 * формата подняли, и старый снимок до сюда не доходит.
 */
function restoreSecrets(world: World, input: unknown): void {
  const raw = asRecord(input, "secrets");
  const secrets = world.secrets;
  const sites = asArray(raw.sites, "secrets.sites");
  if (sites.length !== secrets.sites.length) {
    throw new SnapshotError(`secrets.sites: ${sites.length} мест вместо ${secrets.sites.length}`);
  }

  // Сначала всё читается и проверяется, потом пишется: битый снимок не оставляет мир наполовину тайниковым.
  const parsed = sites.map((entry, i) => {
    const site = asRecord(entry, `secrets.sites[${i}]`);
    const kind = asString(site.kind, `secrets.sites[${i}].kind`);
    if (kind !== secrets.sites[i].kind) {
      throw new SnapshotError(`secrets.sites[${i}].kind: ${kind} вместо ${secrets.sites[i].kind}`);
    }
    return {
      x: asNumber(site.x, `secrets.sites[${i}].x`),
      y: asNumber(site.y, `secrets.sites[${i}].y`),
      active: asBoolean(site.active, `secrets.sites[${i}].active`),
      visible: asBoolean(site.visible, `secrets.sites[${i}].visible`),
      found: asBoolean(site.found, `secrets.sites[${i}].found`),
      used: asBoolean(site.used, `secrets.sites[${i}].used`),
      holdTicks: asNumber(site.holdTicks, `secrets.sites[${i}].holdTicks`),
      opened: asBoolean(site.opened, `secrets.sites[${i}].opened`),
      wave: asArray(site.wave, `secrets.sites[${i}].wave`).map((member, k) => {
        const entry = asRecord(member, `secrets.sites[${i}].wave[${k}]`);
        return {
          slot: asIndex(entry.slot, world.config.maxEnemies, `secrets.sites[${i}].wave[${k}].slot`),
          type: asIndex(entry.type, world.enemyTypes.length, `secrets.sites[${i}].wave[${k}].type`),
        };
      }),
      waveTicks: asNumber(site.waveTicks, `secrets.sites[${i}].waveTicks`),
      hops: asNumber(site.hops, `secrets.sites[${i}].hops`),
      flying: asBoolean(site.flying, `secrets.sites[${i}].flying`),
      hopX: asNumber(site.hopX, `secrets.sites[${i}].hopX`),
      hopY: asNumber(site.hopY, `secrets.sites[${i}].hopY`),
    };
  });
  const rng = asNumber(raw.rng, "secrets.rng");
  const wispRng = asNumber(raw.wispRng, "secrets.wispRng");
  const blessings = asArray(raw.blessings, "secrets.blessings").map((id, i) => asString(id, `secrets.blessings[${i}]`));
  let offer: SecretsSnapshot["offer"] = null;
  if (raw.offer !== null) {
    const entry = asRecord(raw.offer, "secrets.offer");
    offer = {
      siteIndex: asIndex(entry.siteIndex, secrets.sites.length, "secrets.offer.siteIndex"),
      options: asArray(entry.options, "secrets.offer.options").map((id, i) => asString(id, `secrets.offer.options[${i}]`)),
    };
  }

  secrets.rng.setState(rng);
  secrets.wispRng.setState(wispRng);
  parsed.forEach((state, i) => Object.assign(secrets.sites[i], state));
  secrets.offer = offer;
  // Журналы — для сцены: после восстановления она начинает с чистого, событие не повторяется.
  secrets.foundLog = [];
  secrets.usedLog = [];
  secrets.blessingLog = [];
  // Прибавки взятых благословений — заново на мир, собранный из того же набора.
  restoreBlessings(world, blessings);
}

/**
 * Журнал охоты. Отсутствие поля — снимок до журнала: версию формата не
 * поднимали, старый снимок читается, журнал в нём пуст.
 */
function restoreHunt(world: World, input: unknown): void {
  world.hunt.log = [];
  world.hunt.spawnTick.fill(0);
  if (input === undefined) return;
  const raw = asRecord(input, "hunt");
  const log = asArray(raw.log, "hunt.log");
  if (log.length > MAX_HUNT_ENTRIES) throw new SnapshotError(`hunt.log: ${log.length} записей при потолке ${MAX_HUNT_ENTRIES}`);
  const entries = log.map((item, i): RunHuntEntry => {
    const entry = asRecord(item, `hunt.log[${i}]`);
    const rank = entry.rank;
    if (rank !== "elite" && rank !== "boss") throw new SnapshotError(`hunt.log[${i}].rank: ожидался elite или boss`);
    return { rank, value: asNumber(entry.value, `hunt.log[${i}].value`), aliveSec: asNumber(entry.aliveSec, `hunt.log[${i}].aliveSec`) };
  });
  const spawns = asArray(raw.spawns, "hunt.spawns").map((item, i) => {
    const spawn = asRecord(item, `hunt.spawns[${i}]`);
    return { slot: asIndex(spawn.slot, world.config.maxEnemies, `hunt.spawns[${i}].slot`), tick: asNumber(spawn.tick, `hunt.spawns[${i}].tick`) };
  });
  world.hunt.log = entries;
  for (const spawn of spawns) world.hunt.spawnTick[spawn.slot] = spawn.tick;
}

/**
 * Лужи. Отсутствие поля — снимок до луж: версию формата не поднимали, старый снимок читается,
 * луж нет, отсчёт следа идёт с нуля. Тип лужи — индекс врага: за пределами контента это снимок
 * другого контента, а не повод ставить лужу несуществующего врага.
 */
function restoreHazards(world: World, input: unknown): void {
  const fresh = createHazardState(world.config.maxEnemies);
  if (input === undefined) {
    Object.assign(world.hazards.puddles, fresh.puddles);
    world.hazards.trail.ticks.fill(0);
    return;
  }
  const raw = asRecord(input, "hazards");
  decodeRecord(world.hazards.puddles, raw.puddles, "hazards.puddles");
  decodeRecord(world.hazards.trail, raw.trail, "hazards.trail");
  const pool = world.hazards.puddles;
  for (let i = 0; i < pool.alive.length; i++) {
    if (pool.alive[i] === 0) continue;
    if (pool.type[i] >= world.enemyTypes.length || world.enemyTypes[pool.type[i]].trail === null) {
      throw new SnapshotError(`hazards.puddles: лужа ${i} от врага без следа`);
    }
  }
}

function capturedSiege(state: SiegeState): SiegeSnapshot {
  return {
    rng: state.rng.getState(),
    anchored: state.anchored,
    anchorX: state.anchorX,
    anchorY: state.anchorY,
    holdTicks: state.holdTicks,
    warned: state.warned,
    level: state.level,
    active: state.active,
    activeLevel: state.activeLevel,
    cooldownTicks: state.cooldownTicks,
    calmTicks: state.calmTicks,
    count: state.count,
  };
}

/**
 * Осада. Отсутствие поля — снимок до осады: версию формата не поднимали, старый снимок читается, и
 * отсчёт стояния идёт с нуля. Числа проверяются как счётчики: целые, не отрицательные.
 */
function restoreSiege(world: World, input: unknown): void {
  const state = world.siege;
  state.log = [];
  if (input === undefined) {
    Object.assign(state, createSiegeState(state.rng));
    return;
  }
  const raw = asRecord(input, "siege");
  const restored = {
    anchored: asBoolean(raw.anchored, "siege.anchored"),
    anchorX: asNumber(raw.anchorX, "siege.anchorX"),
    anchorY: asNumber(raw.anchorY, "siege.anchorY"),
    holdTicks: asCount(raw.holdTicks, "siege.holdTicks"),
    warned: asBoolean(raw.warned, "siege.warned"),
    level: asCount(raw.level, "siege.level", SIEGE_LEVEL_CEILING),
    active: asBoolean(raw.active, "siege.active"),
    activeLevel: asCount(raw.activeLevel, "siege.activeLevel", SIEGE_LEVEL_CEILING),
    cooldownTicks: asCount(raw.cooldownTicks, "siege.cooldownTicks"),
    calmTicks: asCount(raw.calmTicks, "siege.calmTicks"),
    count: asCount(raw.count, "siege.count"),
  };
  state.rng.setState(asNumber(raw.rng, "siege.rng"));
  Object.assign(state, restored);
}

function capturedStalkerBody(state: StalkerBodyState): StalkerBodySnapshot {
  return {
    slot: state.slot,
    pushWindow: Array.from(state.pushWindow),
    pushCursor: state.pushCursor,
    pushWindowSum: state.pushWindowSum,
    seriesFactor: state.seriesFactor,
    lastPushTick: state.lastPushTick,
    touchCooldownTicks: state.touchCooldownTicks,
    recoverTicks: state.recoverTicks,
  };
}

/**
 * Тело преследователя. Отсутствие поля — снимок до него: версию формата не поднимали, старый снимок
 * читается, и преследователя в нём нет. Слот сверяется с пулом: он обязан быть слотом пула или −1.
 */
function restoreStalkerBody(world: World, input: unknown): void {
  const state = world.stalkerBody;
  resetStalkerBody(state);
  if (input === undefined) return;

  const raw = asRecord(input, "stalkerBody");
  const window = asArray(raw.pushWindow, "stalkerBody.pushWindow");
  if (window.length !== state.pushWindow.length) {
    throw new SnapshotError(`stalkerBody.pushWindow: ${window.length} значений вместо ${state.pushWindow.length}`);
  }
  const values = window.map((value, i) => asNumber(value, `stalkerBody.pushWindow[${i}]`));
  const slot = asNumber(raw.slot, "stalkerBody.slot");
  if (!Number.isInteger(slot) || slot < -1 || slot >= world.config.maxEnemies) {
    throw new SnapshotError(`stalkerBody.slot: ${slot} вне [-1, ${world.config.maxEnemies})`);
  }
  const cursor = asCount(raw.pushCursor, "stalkerBody.pushCursor", state.pushWindow.length - 1);

  state.slot = slot;
  state.pushWindow.set(values);
  state.pushCursor = cursor;
  state.pushWindowSum = asNumber(raw.pushWindowSum, "stalkerBody.pushWindowSum");
  state.seriesFactor = asNumber(raw.seriesFactor, "stalkerBody.seriesFactor");
  state.lastPushTick = asNumber(raw.lastPushTick, "stalkerBody.lastPushTick");
  state.touchCooldownTicks = asCount(raw.touchCooldownTicks, "stalkerBody.touchCooldownTicks");
  state.recoverTicks = asCount(raw.recoverTicks, "stalkerBody.recoverTicks");
}

function capturedStalker(state: StalkerState): StalkerSnapshot {
  return {
    rng: state.rng.getState(),
    phase: state.phase,
    nextOmenTick: state.nextOmenTick,
    x: state.x,
    y: state.y,
    phaseTicks: state.phaseTicks,
    chaseTicks: state.chaseTicks,
    index: state.index,
    hits: state.hits,
    pushes: state.pushes,
    relocations: state.relocations,
    appearedTick: state.appearedTick,
  };
}

/**
 * Директор Карачуна. Отсутствие поля — снимок до него: версию формата не поднимали, старый снимок читается.
 * Фаза — по правилам нового мира (ждёт или выключен), а первое предвестие — не раньше обычной паузы от
 * секунды снимка: забег, начатый давно, не должен вывалить Карачуна сразу; так же читается снимок мира без
 * директора (фаза `off`). Выключенный в мире директор
 * (нет правил, пролог, «Лёгкая», новичок) остаётся выключенным, что бы ни говорил снимок. Погоня и
 * растворение требуют живого тела: оно восстановлено выше.
 */
function restoreStalker(world: World, input: unknown): void {
  const state = world.stalker;
  state.ended = [];
  const appear = state.appear;
  if (appear === null || state.phase === "off") {
    if (input !== undefined) asRecord(input, "stalker");
    return;
  }

  // Снимок мира без директора (фаза `off`) для мира с директором — то же, что снимок без поля.
  const saved = input === undefined ? null : asRecord(input, "stalker");
  if (saved === null || saved.phase === "off") {
    const range = stalkerGapRange(appear, world.stats.tick / TICK_HZ);
    state.phase = "waiting";
    state.nextOmenTick = world.stats.tick + Math.max(1, Math.round(state.rng.nextRange(range.min, range.max) * TICK_HZ));
    state.phaseTicks = 0;
    state.chaseTicks = 0;
    state.index = 0;
    state.hits = 0;
    state.pushes = 0;
    state.relocations = 0;
    state.appearedTick = -1;
    return;
  }

  const raw = saved;
  const phase = asString(raw.phase, "stalker.phase");
  if (!(STALKER_PHASES as readonly string[]).includes(phase)) {
    throw new SnapshotError(`stalker.phase: «${phase}» — неизвестная фаза`);
  }
  const restored = phase as StalkerPhase;
  if ((restored === "chase" || restored === "fading") && stalkerAlive(world) === 0) {
    throw new SnapshotError(`stalker.phase: ${restored}, а тела Карачуна в снимке нет`);
  }
  const appearedTick = asNumber(raw.appearedTick, "stalker.appearedTick");
  if (!Number.isInteger(appearedTick) || appearedTick < -1) throw new SnapshotError(`stalker.appearedTick: ${appearedTick} вне [-1, ∞)`);

  state.rng.setState(asNumber(raw.rng, "stalker.rng"));
  state.phase = restored;
  state.nextOmenTick = asCount(raw.nextOmenTick, "stalker.nextOmenTick");
  state.x = asNumber(raw.x, "stalker.x");
  state.y = asNumber(raw.y, "stalker.y");
  state.phaseTicks = asCount(raw.phaseTicks, "stalker.phaseTicks");
  state.chaseTicks = asCount(raw.chaseTicks, "stalker.chaseTicks");
  state.index = asCount(raw.index, "stalker.index");
  state.hits = asCount(raw.hits, "stalker.hits");
  state.pushes = asCount(raw.pushes, "stalker.pushes");
  state.relocations = asCount(raw.relocations, "stalker.relocations");
  state.appearedTick = appearedTick;
}

function capturedCordon(state: CordonState): Omit<CordonState, "ended"> {
  return {
    active: state.active,
    source: state.source,
    centerX: state.centerX,
    centerY: state.centerY,
    radius: state.radius,
    minRadius: state.minRadius,
    shrinkPerSec: state.shrinkPerSec,
    timeLeftSec: state.timeLeftSec,
    ringsStarted: state.ringsStarted,
    startedAtSec: state.startedAtSec,
    guards: state.guards,
    pending: state.pending.map((entry) => ({ ...entry })),
    pendingLeftSec: state.pendingLeftSec,
  };
}

/**
 * Кольцо стражей. Отсутствие поля — снимок до кольца: версию формата не
 * поднимали, старый снимок читается, и кольца в нём нет.
 */
function restoreCordon(world: World, input: unknown): void {
  if (input === undefined) {
    Object.assign(world.cordon, createCordonState());
    return;
  }
  const raw = asRecord(input, "cordon");
  Object.assign(world.cordon, {
    active: asBoolean(raw.active, "cordon.active"),
    // Снимок до осады источника не знал: все кольца в нём — кольца таймлайна.
    source: raw.source === undefined ? "timeline" : asCordonSource(raw.source, "cordon.source"),
    centerX: asNumber(raw.centerX, "cordon.centerX"),
    centerY: asNumber(raw.centerY, "cordon.centerY"),
    radius: asNumber(raw.radius, "cordon.radius"),
    minRadius: asNumber(raw.minRadius, "cordon.minRadius"),
    shrinkPerSec: asNumber(raw.shrinkPerSec, "cordon.shrinkPerSec"),
    timeLeftSec: asNumber(raw.timeLeftSec, "cordon.timeLeftSec"),
    ringsStarted: raw.ringsStarted === undefined ? 0 : asNumber(raw.ringsStarted, "cordon.ringsStarted"),
    startedAtSec: raw.startedAtSec === undefined ? 0 : asNumber(raw.startedAtSec, "cordon.startedAtSec"),
    guards: raw.guards === undefined ? 0 : asNumber(raw.guards, "cordon.guards"),
    // Снимок до Р166 внутренних врагов не знал: «никого не ждём».
    pending:
      raw.pending === undefined
        ? []
        : asArray(raw.pending, "cordon.pending").map((entry, i) => {
            const item = asRecord(entry, `cordon.pending[${i}]`);
            return {
              typeIndex: asIndex(item.typeIndex, world.enemyTypes.length, `cordon.pending[${i}].typeIndex`),
              x: asNumber(item.x, `cordon.pending[${i}].x`),
              y: asNumber(item.y, `cordon.pending[${i}].y`),
            };
          }),
    pendingLeftSec: raw.pendingLeftSec === undefined ? 0 : asNumber(raw.pendingLeftSec, "cordon.pendingLeftSec"),
    ended: [],
  });
}

/**
 * Рубеж. Отсутствие поля — снимок до рубежа: версию формата не поднимали. Отметка
 * ещё впереди — страж придёт как обычно, позади — забег начат без него и страж
 * в него не вмешивается. Мир без стража (нет правил или врага в контенте)
 * остаётся «пропущен», что бы ни сказал снимок о фазе «ждёт».
 */
function restoreRubezh(world: World, input: unknown): void {
  const state = world.rubezh;
  if (input === undefined) {
    if (state.guardType >= 0) state.phase = world.stats.tick < state.atTick ? "pending" : "skipped";
    state.clearedSec = null;
    return;
  }
  const raw = asRecord(input, "rubezh");
  const phase = asString(raw.phase, "rubezh.phase");
  if (!(RUBEZH_PHASES as readonly string[]).includes(phase)) throw new SnapshotError(`rubezh.phase: «${phase}» — неизвестная фаза`);
  const restored = phase as RubezhPhase;
  if (state.guardType < 0 && (restored === "guard" || restored === "cleared")) {
    throw new SnapshotError(`rubezh.phase: ${restored}, а стража в контенте этого забега нет`);
  }
  const clearedSec = raw.clearedSec === null ? null : asNumber(raw.clearedSec, "rubezh.clearedSec");
  if ((restored === "cleared") !== (clearedSec !== null)) {
    throw new SnapshotError("rubezh.clearedSec: секунда победы задана не в той фазе");
  }
  state.rng.setState(asNumber(raw.rng, "rubezh.rng"));
  state.phase = state.guardType < 0 ? "skipped" : restored;
  state.clearedSec = clearedSec;
}

/**
 * Пролог. Режим мира собран заранее по режиму снимка забега, поэтому здесь только
 * сверка: снимок пролога в мир обычного забега (и наоборот) не грузится — иначе
 * забег продолжился бы на чужом таймлайне.
 */
function restorePrologue(world: World, input: unknown): void {
  const state = world.prologue;
  if (state === null) {
    if (input !== undefined) throw new SnapshotError("prologue: снимок пролога, а мир обычного забега");
    return;
  }
  if (input === undefined) throw new SnapshotError("prologue: снимок обычного забега, а мир пролога");
  const raw = asRecord(input, "prologue");
  state.lastWardTick = asNumber(raw.lastWardTick, "prologue.lastWardTick");
  state.firstOfferMade = asBoolean(raw.firstOfferMade, "prologue.firstOfferMade");
}

// --- Набор и прогрессия -------------------------------------------------------

function restoreLoadout(world: World, input: unknown): World["loadout"] {
  const loadout = asRecord(input, "loadout");
  const weapons = asArray(loadout.weapons, "loadout.weapons").map((raw, i) => {
    const slot = asRecord(raw, `loadout.weapons[${i}]`);
    const typeIndex = asIndex(slot.typeIndex, world.weaponTypes.length, `loadout.weapons[${i}].typeIndex`);
    return {
      typeIndex,
      level: asNumber(slot.level, `loadout.weapons[${i}].level`),
      cooldown: asNumber(slot.cooldown, `loadout.weapons[${i}].cooldown`),
      dirX: asNumber(slot.dirX, `loadout.weapons[${i}].dirX`),
      dirY: asNumber(slot.dirY, `loadout.weapons[${i}].dirY`),
    };
  });
  const passives = asArray(loadout.passives, "loadout.passives").map((raw, i) => {
    const slot = asRecord(raw, `loadout.passives[${i}]`);
    return {
      typeIndex: asIndex(slot.typeIndex, world.passiveTypes.length, `loadout.passives[${i}].typeIndex`),
      level: asNumber(slot.level, `loadout.passives[${i}].level`),
    };
  });
  return { weapons, passives };
}

function restoreProgression(input: unknown, limitCount: number): World["progression"] {
  const progression = asRecord(input, "progression");
  return {
    level: asNumber(progression.level, "progression.level"),
    xp: asNumber(progression.xp, "progression.xp"),
    xpToNext: asNumber(progression.xpToNext, "progression.xpToNext"),
    totalXp: asNumber(progression.totalXp, "progression.totalXp"),
    pendingLevelUps: asNumber(progression.pendingLevelUps, "progression.pendingLevelUps"),
    // Варианты выбора переносятся как есть. От подделки снимок не защищён —
    // это данные устройства самого игрока; незнакомый предмет в варианте
    // выбор просто пропускает (`chooseUpgrade`), а не роняет забег.
    offers: cloneJson(asArray(progression.offers, "progression.offers")) as World["progression"]["offers"],
    tools: restoreCardTools(progression.tools, "progression.tools"),
    toolsTotal: restoreCardTools(progression.toolsTotal, "progression.toolsTotal"),
    banished: asArray(progression.banished, "progression.banished").map((key, i) => asString(key, `progression.banished[${i}]`)),
    limitStacks: restoreLimitStacks(progression.limitStacks, limitCount),
  };
}

/**
 * Стопки «Предела»: длина обязана сойтись с записями мира, иначе снимок —
 * другого контента, а не повод молча сдвинуть прибавки на чужие параметры.
 * Отрицательное или дробное число отвергается: оно дало бы мир с NaN в
 * характеристиках.
 */
function restoreLimitStacks(input: unknown, limitCount: number): number[] {
  const raw = asArray(input, "progression.limitStacks");
  if (raw.length !== limitCount) {
    throw new SnapshotError(`progression.limitStacks: ${raw.length} записей, в мире ${limitCount}`);
  }
  return raw.map((value, i) => {
    const count = asNumber(value, `progression.limitStacks[${i}]`);
    if (!Number.isInteger(count) || count < 0) {
      throw new SnapshotError(`progression.limitStacks[${i}]: целое от 0, а не ${count}`);
    }
    return count;
  });
}

function restoreCardTools(input: unknown, path: string): World["progression"]["tools"] {
  const tools = asRecord(input, path);
  // Заряды из хранилища устройства не выше страховки движка: подправленный
  // снимок не должен выдавать бесконечные перебросы.
  const charge = (kind: "reroll" | "skip" | "banish"): number =>
    Math.min(MAX_CARD_TOOLS, Math.max(0, Math.floor(asNumber(tools[kind], `${path}.${kind}`))));
  return { reroll: charge("reroll"), skip: charge("skip"), banish: charge("banish") };
}

// --- Типизированные массивы ---------------------------------------------------

function encodeRecord(source: object, count: number): EncodedPool {
  const scalars: Record<string, number> = {};
  const arrays: Record<string, EncodedArray> = {};

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number") {
      scalars[key] = value;
      continue;
    }
    if (isTypedArray(value)) {
      arrays[key] = encodeArray(value, Math.min(count, value.length));
    }
  }
  return { scalars, arrays };
}

function decodeRecord(target: object, input: unknown, path: string): void {
  const encoded = asRecord(input, path);
  const scalars = asRecord(encoded.scalars, `${path}.scalars`);
  const arrays = asRecord(encoded.arrays, `${path}.arrays`);
  const record = target as Record<string, unknown>;

  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number") {
      record[key] = asNumber(scalars[key], `${path}.${key}`);
      continue;
    }
    if (isTypedArray(value)) {
      decodeArrayInto(value, arrays[key], `${path}.${key}`);
    }
  }
}

function encodeArray(array: TypedArray, length: number): EncodedArray {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, length * array.BYTES_PER_ELEMENT);
  return { kind: kindOf(array), length, data: bytesToBase64(bytes) };
}

function decodeArrayInto(target: TypedArray, input: unknown, path: string): void {
  const encoded = asRecord(input, path);
  if (encoded.kind !== kindOf(target)) {
    throw new SnapshotError(`${path}: тип ${String(encoded.kind)} вместо ${kindOf(target)}`);
  }
  const length = asNumber(encoded.length, `${path}.length`);
  if (!Number.isInteger(length) || length < 0 || length > target.length) {
    throw new SnapshotError(`${path}: длина ${length} при ёмкости ${target.length}`);
  }
  if (typeof encoded.data !== "string") throw new SnapshotError(`${path}: нет данных`);

  const bytes = base64ToBytes(encoded.data, path);
  if (bytes.length !== length * target.BYTES_PER_ELEMENT) {
    throw new SnapshotError(`${path}: ${bytes.length} байт вместо ${length * target.BYTES_PER_ELEMENT}`);
  }
  new Uint8Array(target.buffer, target.byteOffset, bytes.length).set(bytes);
}

function isTypedArray(value: unknown): value is TypedArray {
  return (
    value instanceof Float64Array ||
    value instanceof Float32Array ||
    value instanceof Int32Array ||
    value instanceof Int16Array ||
    value instanceof Uint32Array ||
    value instanceof Uint8Array
  );
}

function kindOf(array: TypedArray): TypedKind {
  if (array instanceof Float64Array) return "f64";
  if (array instanceof Float32Array) return "f32";
  if (array instanceof Int32Array) return "i32";
  if (array instanceof Int16Array) return "i16";
  if (array instanceof Uint32Array) return "u32";
  return "u8";
}

/**
 * base64 кусками: `String.fromCharCode(...bytes)` на сотнях килобайт упирается
 * в предел числа аргументов функции.
 */
const BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(data: string, path: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw new SnapshotError(`${path}: испорченный base64`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- Проверки формы ------------------------------------------------------------

function assignNumbers(target: object, input: unknown, path: string): void {
  const source = asRecord(input, path);
  const record = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "number") continue;
    record[key] = asNumber(source[key], `${path}.${key}`);
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SnapshotError(`${path}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new SnapshotError(`${path}: ожидался массив`);
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new SnapshotError(`${path}: ожидалось число`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new SnapshotError(`${path}: ожидалась строка`);
  return value;
}

function asCordonSource(value: unknown, path: string): CordonSource {
  const source = asString(value, path);
  if (!(CORDON_SOURCES as readonly string[]).includes(source)) throw new SnapshotError(`${path}: «${source}» — неизвестный источник кольца`);
  return source as CordonSource;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new SnapshotError(`${path}: ожидался признак`);
  return value;
}

/** Счётчик: целое от нуля до `max` включительно. */
function asCount(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): number {
  const count = asNumber(value, path);
  if (!Number.isInteger(count) || count < 0 || count > max) throw new SnapshotError(`${path}: ${count} вне [0, ${max}]`);
  return count;
}

function asIndex(value: unknown, length: number, path: string): number {
  const index = asNumber(value, path);
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new SnapshotError(`${path}: индекс ${index} вне [0, ${length})`);
  }
  return index;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
