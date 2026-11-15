import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import type { EmblemTier, TaskDef } from "../tasks/task-rules.js";
import { TasksService } from "../tasks/tasks.service.js";
import { percentOf } from "./achievement-rules.js";
import { EmblemNotFoundError, EmblemNotHeldError } from "./emblem-errors.js";
import {
  emblemItemOf,
  heldSeason,
  heldStatus,
  isEmblemDef,
  isVipActive,
  publicEmblemOf,
  shownEmblem,
  type EmblemsView,
  type PublicEmblem,
  type PublicMark,
} from "./emblem-rules.js";
import { ACHIEVEMENTS_REPOSITORY, type AchievementsRepository } from "./achievements.repository.js";
import { EMBLEMS_REPOSITORY, type EmblemsRepository } from "./emblems.repository.js";

/**
 * Знаки у имени (docs/35-stage4-plan.md Р149, tasks/T-0235): какие знаки держит игрок,
 * какой из них у его имени и выбор знака. Каталог знаков — строки заданий с редкостью
 * `emblem_tier` (модуль заданий держит его в памяти), поэтому названия и редкость правятся
 * из панели без релиза и без запросов к базе на каждую строку списка.
 *
 * Держит ли игрок знак, считается при чтении: выполненное достижение — по прогрессу,
 * статус и сезонное место — по состоянию аккаунта. Выбранный знак, переставший держаться
 * (истёк VIP), показывается знаком по умолчанию, ничего снимать не нужно.
 *
 * Знаки для списков готовит `of`: список аккаунтов — четыре запроса, по одному на источник
 * (аккаунт, VIP, сезоны, достижения), сколько бы строк ни было в списке.
 */

const DB_TIMEOUT_MS = 3_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Выбранный знак и то, что показывается: ответ на выбор. */
export interface EmblemChoice {
  shown: string | null;
  auto: boolean;
}

/** Строка каталога, ставшая знаком: название и редкость заданы. */
type CatalogDef = TaskDef & { title: string; emblemTier: EmblemTier };

interface Standing {
  held: Set<string>;
  chosen: string | null;
  /** порядковые номера сезонов у сезонных знаков */
  seasons: Map<string, number>;
}

@Injectable()
export class EmblemsService {
  private readonly logger = new Logger("emblems");

  constructor(
    private readonly tasks: TasksService,
    @Inject(EMBLEMS_REPOSITORY) private readonly repository: EmblemsRepository,
    @Inject(ACHIEVEMENTS_REPOSITORY) private readonly rarity: Pick<AchievementsRepository, "rarity">,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
  ) {}

  /**
   * Знак у имени для списка аккаунтов — один запрос на источник, а не на строку. У каждого
   * найденного аккаунта запись есть, у без знака — пустая. Не-uuid отбрасывается: чужая строка не
   * должна ронять запрос на всю таблицу.
   */
  async of(accountIds: readonly string[], at = new Date()): Promise<Map<string, PublicMark>> {
    const valid = [...new Set(accountIds.filter((id) => UUID.test(id)))];
    const marks = new Map<string, PublicMark>();
    if (valid.length === 0) return marks;
    const catalog = await this.catalog();
    const standings = await this.standings(valid, catalog, at, true);
    for (const [accountId, standing] of standings) {
      const shown = shownEmblem(standing.chosen, standing.held);
      const def = shown === null ? undefined : catalog.get(shown);
      marks.set(accountId, def === undefined ? {} : { emblem: publicEmblemOf(def, standing.seasons.get(def.taskId) ?? null) });
    }
    return marks;
  }

  /** Раздел «Знаки» игрока: все знаки каталога, держимые и закрытые, и какой носится. */
  async listFor(accountId: string, at = new Date()): Promise<EmblemsView> {
    const catalog = await this.catalog();
    const [standings, rarity] = await Promise.all([this.standings([accountId], catalog, at, true), this.db(this.rarity.rarity())]);
    const standing = standings.get(accountId) ?? nobody();
    const minPlayers = this.settings.get(SETTINGS.achievementsRarityMinPlayers);
    const items = [...catalog.values()].map((def) => {
      const stat = rarity.rows.get(def.taskId);
      return emblemItemOf(def, standing.held.has(def.taskId), standing.seasons.get(def.taskId) ?? null, stat === undefined ? null : percentOf(stat.holders, stat.population, minPlayers));
    });
    return { shown: shownEmblem(standing.chosen, standing.held), auto: !isChosenHeld(standing), items };
  }

  /**
   * Выбрать знак у имени; `null` — вернуть «по умолчанию». Выбрать можно только то, что игрок
   * держит: знака нет в каталоге — `EmblemNotFoundError`, не держится — `EmblemNotHeldError`.
   * Повтор того же выбора ничего не пишет.
   */
  async choose(accountId: string, emblemId: string | null, at = new Date()): Promise<EmblemChoice> {
    const catalog = await this.catalog();
    const standing = (await this.standings([accountId], catalog, at, true)).get(accountId) ?? nobody();
    if (emblemId !== null) {
      if (!catalog.has(emblemId)) throw new EmblemNotFoundError();
      if (!standing.held.has(emblemId)) throw new EmblemNotHeldError();
    }
    const changed = await this.db(this.repository.setShown(accountId, emblemId));
    if (changed) this.logger.log(JSON.stringify({ module: "emblems", event: "emblem_shown_set", accountId, emblem: emblemId ?? "auto" }));
    const next = { ...standing, chosen: emblemId };
    return { shown: shownEmblem(next.chosen, next.held), auto: !isChosenHeld(next) };
  }

  /**
   * Все знаки, которые аккаунт держит сейчас, включая заслуги, — для карточки игрока (T-0247).
   * Названия — из каталога, у сезонного знака — номер сезона. Порядок каталога; отбор лучших по
   * редкости — дело карточки. Четыре запроса, как у `of`.
   */
  async heldList(accountId: string, at = new Date()): Promise<PublicEmblem[]> {
    const catalog = await this.catalog();
    const standing = (await this.standings([accountId], catalog, at, true)).get(accountId);
    if (standing === undefined) return [];
    return [...catalog.values()].filter((def) => standing.held.has(def.taskId)).map((def) => publicEmblemOf(def, standing.seasons.get(def.taskId) ?? null));
  }

  /**
   * Статусные и сезонные знаки, которые аккаунт держит сейчас, — без достижений: витрина и «любимые»
   * знают выполненные достижения сами. Три запроса.
   */
  async heldSpecial(accountId: string, at = new Date()): Promise<ReadonlySet<string>> {
    const standings = await this.standings([accountId], await this.catalog(), at, false);
    return standings.get(accountId)?.held ?? new Set<string>();
  }

  /** Знаки каталога по id в порядке панели: включённые строки с редкостью и названием. */
  private async catalog(): Promise<Map<string, CatalogDef>> {
    const defs = (await this.tasks.achievementDefs()).filter(isEmblemDef);
    // Сравнение строк, а не `localeCompare`: порядок не должен зависеть от локали сервера.
    defs.sort((a, b) => a.sort - b.sort || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    return new Map(defs.map((def) => [def.taskId, def]));
  }

  /**
   * Что держит каждый из аккаунтов. Источников четыре — аккаунт, VIP, сезоны, достижения со знаком, —
   * и каждый читается одним запросом на весь список. Знак вне каталога (выключен в панели) не держится.
   */
  private async standings(accountIds: readonly string[], catalog: ReadonlyMap<string, CatalogDef>, at: Date, withMerit: boolean): Promise<Map<string, Standing>> {
    const [statuses, vip, seasons, merit] = await Promise.all([
      this.db(this.repository.statuses(accountIds)),
      this.db(this.repository.vipUntil(accountIds)),
      this.db(this.repository.standings(accountIds)),
      withMerit ? this.db(this.repository.merit(accountIds)) : Promise.resolve(new Map<string, Set<string>>()),
    ]);
    const result = new Map<string, Standing>();
    for (const [accountId, account] of statuses) {
      const standing = seasons.get(accountId);
      const held = new Set<string>([
        ...heldStatus({
          vipActive: isVipActive(vip.get(accountId) ?? null, at),
          testerAt: account.testerAt,
          supporterAt: account.supporterAt,
          hasRole: account.hasRole,
          partnerActive: account.partnerActive,
        }),
        ...heldSeason(standing?.bestPlace ?? null),
        ...(merit.get(accountId) ?? []),
      ]);
      result.set(accountId, {
        held: new Set([...held].filter((id) => catalog.has(id))),
        chosen: account.shownEmblemId,
        seasons: standing?.seasons ?? new Map<string, number>(),
      });
    }
    return result;
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "знаки");
  }
}

/** Аккаунта в базе нет: держит он то же, что и никто. */
function nobody(): Standing {
  return { held: new Set<string>(), chosen: null, seasons: new Map<string, number>() };
}

/** Выбранный знак есть и держится: иначе у имени знак по умолчанию. */
function isChosenHeld(standing: Pick<Standing, "chosen" | "held">): boolean {
  return standing.chosen !== null && standing.held.has(standing.chosen);
}
