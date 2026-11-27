import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PublicMark } from "../../common/public-identity.js";
import { isVipActive } from "../achievements/emblem-rules.js";
import { EMBLEMS_REPOSITORY, type EmblemsRepository } from "../achievements/emblems.repository.js";
import { POINT_STEPS } from "../tasks/task-points.js";
import { TasksService } from "../tasks/tasks.service.js";
import { APPEARANCES, DEFAULT_APPEARANCE, appearanceById, type AppearanceSource } from "./appearance-catalog.js";
import { AppearanceLockedError, AppearanceNotFoundError } from "./appearance-errors.js";
import {
  effectiveAppearance,
  heldAppearances,
  type AppearanceChoice,
  type AppearanceChoiceInput,
  type AppearanceItemView,
  type AppearanceSourceView,
  type AppearanceView,
} from "./appearance-rules.js";
import { APPEARANCE_GRANTS_REPOSITORY, type AppearanceGrantsRepository } from "./appearance-grants.repository.js";
import { APPEARANCE_REPOSITORY, type AppearanceRepository } from "./appearance.repository.js";

/**
 * Облики героя (docs/35-stage4-plan.md Р150, tasks/T-0237): каким обликом владеет игрок, какой
 * из них выбран и какой действует. Владение считается при чтении по состоянию аккаунта —
 * уровню, VIP, достижению, забранной ступени недели и месту в сезоне — и по обликам,
 * выданным разово (`appearance_grant`, tasks/T-0245); в базе хранится выбор и эти выдачи. Выбранный
 * облик, которым игрок больше не владеет (истёк VIP, возвращён набор), остаётся выбранным, а в
 * ответах вместо него действует `keeper`.
 *
 * Облик для строк списков готовит `of`: список аккаунтов — шесть запросов, по одному на источник
 * (аккаунт с уровнем, достижения, ступень недели, выдачи, VIP, сезоны), сколько бы строк ни было.
 * VIP и место в сезоне читает репозиторий знаков (T-0235) теми же методами.
 */

const DB_TIMEOUT_MS = 3_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Верхняя ступень очков недели — та, что даёт Ведунью. */
const TOP_WEEKLY_POINTS = POINT_STEPS.weekly[POINT_STEPS.weekly.length - 1].points;

/** Достижения, от которых зависит владение: список собирается из каталога, а не помнится отдельно. */
const OWNERSHIP_ACHIEVEMENTS: readonly string[] = APPEARANCES.flatMap((def) => (def.source.kind === "achievement" ? [def.source.achievementId] : []));

interface Standing {
  held: Set<string>;
  /** сохранённый выбор; пусто — не выбирал */
  selected: string | null;
  avatarPhoto: boolean;
}

@Injectable()
export class AppearanceService {
  private readonly logger = new Logger("appearance");

  constructor(
    private readonly tasks: TasksService,
    @Inject(APPEARANCE_REPOSITORY) private readonly repository: AppearanceRepository,
    @Inject(EMBLEMS_REPOSITORY) private readonly emblems: Pick<EmblemsRepository, "vipUntil" | "standings">,
    @Inject(APPEARANCE_GRANTS_REPOSITORY) private readonly grants: AppearanceGrantsRepository,
  ) {}

  /**
   * Облик для списка аккаунтов — один запрос на источник, а не на строку. У каждого найденного
   * аккаунта запись есть: действующий облик и, если игрок выбрал фото, `avatarPhoto`. Не-uuid
   * отбрасывается: чужая строка не должна ронять запрос на всю таблицу.
   */
  async of(accountIds: readonly string[], at = new Date()): Promise<Map<string, PublicMark>> {
    const valid = [...new Set(accountIds.filter((id) => UUID.test(id)))];
    const marks = new Map<string, PublicMark>();
    if (valid.length === 0) return marks;
    for (const [accountId, standing] of await this.standings(valid, at)) {
      marks.set(accountId, { appearance: effectiveAppearance(standing.selected, standing.held), ...(standing.avatarPhoto ? { avatarPhoto: true as const } : {}) });
    }
    return marks;
  }

  /** Раздел «Облики» игрока: весь каталог с отметкой «держит», откуда берётся, и выбор. */
  async viewFor(accountId: string, at = new Date()): Promise<AppearanceView> {
    const [standings, titles] = await Promise.all([this.standings([accountId], at), this.achievementTitles()]);
    const standing = standings.get(accountId) ?? nobody();
    const items = APPEARANCES.map((def): AppearanceItemView => ({ id: def.id, archetype: def.archetype, rarity: def.rarity, held: standing.held.has(def.id), source: sourceView(def.source, titles) }));
    return { ...choiceOf(standing), items };
  }

  /**
   * Выбрать облик и/или кружок аватара. Облик выбирается только полученный: нет в каталоге —
   * `AppearanceNotFoundError`, не получен — `AppearanceLockedError`; ничего из тела при отказе не
   * записывается. Кружок аватара владения не требует. Повтор того же выбора ничего не пишет.
   */
  async choose(accountId: string, input: AppearanceChoiceInput, at = new Date()): Promise<AppearanceChoice> {
    const standing = (await this.standings([accountId], at)).get(accountId) ?? nobody();
    if (input.id !== undefined) {
      if (appearanceById(input.id) === undefined) throw new AppearanceNotFoundError();
      if (!standing.held.has(input.id)) throw new AppearanceLockedError();
    }
    const changed = await this.db(
      this.repository.setChoice(accountId, {
        ...(input.id === undefined ? {} : { appearanceId: input.id }),
        ...(input.avatarPhoto === undefined ? {} : { avatarPhoto: input.avatarPhoto }),
      }),
    );
    if (changed) this.logger.log(JSON.stringify({ module: "appearance", event: "appearance_set", accountId, appearance: input.id ?? null, avatarPhoto: input.avatarPhoto ?? null }));
    return choiceOf({ ...standing, selected: input.id ?? standing.selected, avatarPhoto: input.avatarPhoto ?? standing.avatarPhoto });
  }

  /**
   * Чем владеет каждый из аккаунтов. Источников шесть, и каждый читается одним запросом на весь
   * список. У аккаунта, которого нет в базе, записи нет.
   */
  private async standings(accountIds: readonly string[], at: Date): Promise<Map<string, Standing>> {
    const [rows, done, weekly, granted, vip, seasons] = await Promise.all([
      this.db(this.repository.accounts(accountIds)),
      this.db(this.repository.completed(accountIds, OWNERSHIP_ACHIEVEMENTS)),
      this.db(this.repository.weeklyClaimed(accountIds, TOP_WEEKLY_POINTS)),
      this.db(this.grants.held(accountIds)),
      this.db(this.emblems.vipUntil(accountIds)),
      this.db(this.emblems.standings(accountIds)),
    ]);
    const result = new Map<string, Standing>();
    for (const [accountId, row] of rows) {
      const held = heldAppearances({
        level: row.level,
        vipActive: isVipActive(vip.get(accountId) ?? null, at),
        bestSeasonPlace: seasons.get(accountId)?.bestPlace ?? null,
        doneAchievements: done.get(accountId) ?? new Set<string>(),
        weeklyTopClaimed: weekly.has(accountId),
        grants: granted.get(accountId) ?? new Set<string>(),
      });
      result.set(accountId, { held, selected: row.appearanceId, avatarPhoto: row.avatarPhoto });
    }
    return result;
  }

  /** Названия достижений-источников из каталога заданий: правятся из панели, поэтому не зашиты. */
  private async achievementTitles(): Promise<Map<string, string>> {
    const defs = await this.tasks.achievementDefs();
    return new Map(defs.flatMap((def) => (def.title === null ? [] : [[def.taskId, def.title] as const])));
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "облики");
  }
}

/** Аккаунта в базе нет: владеет он тем же, что и никто. */
function nobody(): Standing {
  return { held: new Set<string>([DEFAULT_APPEARANCE]), selected: null, avatarPhoto: false };
}

function choiceOf(standing: Standing): AppearanceChoice {
  return { selected: standing.selected ?? DEFAULT_APPEARANCE, effective: effectiveAppearance(standing.selected, standing.held), avatarPhoto: standing.avatarPhoto };
}

function sourceView(source: AppearanceSource, titles: ReadonlyMap<string, string>): AppearanceSourceView {
  if (source.kind !== "achievement") return source;
  const title = titles.get(source.achievementId);
  return title === undefined ? source : { ...source, title };
}
