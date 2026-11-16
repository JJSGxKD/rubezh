import { Inject, Injectable, Logger } from "@nestjs/common";
import type { PublicIdentity } from "../../common/public-identity.js";
import { withTimeout } from "../../common/with-timeout.js";
import type { AchievementsService } from "../achievements/achievements.service.js";
import type { EmblemsService } from "../achievements/emblems.service.js";
import { DEFAULT_APPEARANCE } from "../appearance/appearance-catalog.js";
import type { AccountRepository } from "../auth/account.repository.js";
import type { FriendsRepository } from "../friends/friends.repository.js";
import type { ItemsService } from "../items/items.service.js";
import type { ProgressService } from "../progress/progress.service.js";
import type { RatingRestrictions } from "../runs/rating-restrictions.js";
import type { RunsViewService } from "../runs/runs-view.service.js";
import type { SeasonsViewService } from "../seasons/seasons-view.service.js";
import type { VipService } from "../vip/vip.service.js";
import { isHiddenFrom, relationOf, topEmblems, type PlayerCard } from "./player-card-rules.js";
import { PlayerNotFoundError } from "./players-errors.js";

/**
 * Карточка игрока (docs/35-stage4-plan.md Р47, Р48, tasks/T-0247): облик, знаки, уровень, мощь,
 * место в сезоне, числа забегов, витрина и отношение смотрящего. Карточка только собирает: каждое
 * число считает его модуль-хозяин, а здесь решается, кому она видна и что делать, если блок не
 * ответил.
 *
 * Внутренний `accountId` и id площадки в ответ не попадают — игрока называет публичный id. Число
 * запросов не зависит от игрока: каждый блок — один вызов своего модуля, все параллельно.
 *
 * Числа читаются по доске смотрящего (Р104, T-0113): карточка не показывает того, чего он не видит
 * в своём рейтинге, и не обходит скрытие — игрок отдельной доски для читающего общую так же
 * «не найден», как несуществующий и заблокированный.
 */

const BLOCK_TIMEOUT_MS = 3_000;

/** Что карточка берёт у соседних модулей: узкие порты, чтобы тест подставлял их без базы. */
export interface PlayerSources {
  accounts: Pick<AccountRepository, "byPublicId">;
  friends: Pick<FriendsRepository, "areFriends" | "hasRequest">;
  rating: Pick<RatingRestrictions, "boardOf">;
  runs: Pick<RunsViewService, "cardStats">;
  seasons: Pick<SeasonsViewService, "placeOf">;
  progress: { view(accountId: string): Promise<Pick<Awaited<ReturnType<ProgressService["view"]>>, "level">> };
  items: Pick<ItemsService, "powerOf">;
  achievements: Pick<AchievementsService, "summary">;
  emblems: Pick<EmblemsService, "heldList">;
  vip: Pick<VipService, "activeAt">;
  identity: Pick<PublicIdentity, "of">;
}

export const PLAYER_SOURCES = Symbol("PLAYER_SOURCES");

@Injectable()
export class PlayersService {
  private readonly logger = new Logger("players");

  constructor(@Inject(PLAYER_SOURCES) private readonly sources: PlayerSources) {}

  /**
   * Карточка игрока по публичному id глазами `viewerId`. Нет такого, заблокирован или скрыт правилом
   * доски — `PlayerNotFoundError`, до чтения каких-либо блоков.
   */
  async card(viewerId: string, publicId: string, at = new Date()): Promise<PlayerCard> {
    const { sources } = this;
    const target = await this.hard("аккаунт", sources.accounts.byPublicId(publicId));
    if (target === null || target.bannedAt !== null) throw new PlayerNotFoundError();
    const self = target.accountId === viewerId;
    if (!self) {
      const [viewerBoard, targetBoard] = await Promise.all([this.hard("доска смотрящего", sources.rating.boardOf(viewerId, at)), this.hard("доска игрока", sources.rating.boardOf(target.accountId, at))]);
      if (isHiddenFrom(viewerBoard, targetBoard)) throw new PlayerNotFoundError();
    }

    const id = target.accountId;
    const [marks, held, level, power, stats, season, summary, vip, friends, outgoing, incoming] = await Promise.all([
      this.soft("метки", new Map(), sources.identity.of([id])),
      this.soft("знаки", [], sources.emblems.heldList(id, at)),
      this.hard("уровень", sources.progress.view(id)),
      this.hard("мощь", sources.items.powerOf(id)),
      this.hard("числа забегов", sources.runs.cardStats(id, viewerId)),
      this.soft("место в сезоне", null, sources.seasons.placeOf(id, viewerId, at)),
      this.soft("витрина", null, sources.achievements.summary(id)),
      this.soft("VIP", false, sources.vip.activeAt(id, at)),
      self ? Promise.resolve(false) : this.hard("друзья", sources.friends.areFriends(viewerId, id)),
      self ? Promise.resolve(false) : this.hard("исходящая заявка", sources.friends.hasRequest(viewerId, id)),
      self ? Promise.resolve(false) : this.hard("входящая заявка", sources.friends.hasRequest(id, viewerId)),
    ]);

    const mark = marks.get(id);
    return {
      publicId: target.publicId ?? publicId,
      name: target.displayName,
      ...(target.photoUrl === null ? {} : { photoUrl: target.photoUrl }),
      appearance: mark?.appearance ?? DEFAULT_APPEARANCE,
      ...(mark?.avatarPhoto === true ? { avatarPhoto: true as const } : {}),
      ...(mark?.emblem === undefined ? {} : { emblem: mark.emblem }),
      emblems: { held: held.length, top: topEmblems(held) },
      level: level.level,
      power,
      season: season === null ? null : { place: season },
      stats,
      prestige: summary?.prestige ?? 0,
      favorites: summary?.favorites ?? [],
      relation: relationOf({ self, friends, outgoing, incoming }),
      ...(vip ? { vip: true as const } : {}),
    };
  }

  /** Обязательный блок: сбой или тишина дольше потолка — ошибка карточки. */
  private async hard<T>(name: string, promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, BLOCK_TIMEOUT_MS, `карточка: ${name}`);
  }

  /** Необязательный блок: сбой — запасное значение и строка в лог, карточка отдаётся. */
  private async soft<T>(name: string, fallback: T, promise: Promise<T>): Promise<T> {
    try {
      return await withTimeout(promise, BLOCK_TIMEOUT_MS, `карточка: ${name}`);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "players", event: "card_block_failed", block: name, reason: error instanceof Error ? error.message : "unknown" }));
      return fallback;
    }
  }
}
