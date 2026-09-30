import { Inject, Injectable } from "@nestjs/common";
import { ForbiddenError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { decodePlayerCursor, encodePlayerCursor, type PlayerListQuery } from "./player-list-query.js";
import { PLAYER_LIST_REPOSITORY, type PlayerListRepository, type PlayerListRow } from "./player-list.repository.js";

/**
 * Список игроков в панели (docs/35-stage4-plan.md WP32, Р62): модератор
 * находит игрока фильтрами, а не только поиском по имени. Права — как у
 * карточки: список — `players.view`, Telegram ID и юзернейм — только с
 * `players.pii.view` и записью в аудит, платящий — только с
 * `analytics.revenue.view`: модератор видит игроков «без платежей»
 * (docs/29-admin-panel.md §3.3), и фильтром по оплатам их не обойти.
 */

const DB_TIMEOUT_MS = 5_000;

export interface PlayerListItem {
  accountId: string;
  platform: string;
  displayName: string;
  photoUrl: string | null;
  createdAt: string;
  lastSeenAt: string;
  level: number;
  source: string | null;
  campaign: string | null;
  /** `null` — нет права на выручку */
  payer: boolean | null;
  canMessage: boolean | null;
  banned: { at: string; reason: string | null } | null;
  pii: { platformUserId: string; username: string | null } | null;
}

export interface PlayerListView {
  players: PlayerListItem[];
  /** следующая страница; `null` — дальше пусто */
  nextCursor: string | null;
}

@Injectable()
export class PlayerListService {
  constructor(
    @Inject(PLAYER_LIST_REPOSITORY) private readonly repository: PlayerListRepository,
    private readonly roles: RolesService,
  ) {}

  async list(actor: AccountRef, query: PlayerListQuery): Promise<PlayerListView> {
    await this.roles.require(actor, "players.view");
    const [withPii, withPayments] = await Promise.all([this.roles.can(actor, "players.pii.view"), this.roles.can(actor, "analytics.revenue.view")]);
    if (query.payer !== undefined && !withPayments) throw new ForbiddenError("Фильтр по оплатам — с правом на выручку");

    const { sort, order, cursor, limit, ...filters } = query;
    const rows = await withTimeout(
      this.repository.page({ filters, sort, order, cursor: cursor === undefined ? null : decodePlayerCursor(cursor, sort), limit: limit + 1 }),
      DB_TIMEOUT_MS,
      "список игроков",
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    // Идентификаторы площадки в списке — та же работа с персональными данными, что поиск по ним.
    if (withPii && page.length > 0) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "players.pii.view", target: null, after: { list: filters, shown: page.length } });
    }
    return {
      players: page.map((row) => itemOf(row, withPii, withPayments)),
      nextCursor: rows.length > limit && last !== undefined ? encodePlayerCursor({ sort, value: cursorValue(last, sort), accountId: last.accountId }) : null,
    };
  }
}

function cursorValue(row: PlayerListRow, sort: PlayerListQuery["sort"]): number {
  if (sort === "registered") return row.createdAt.getTime();
  if (sort === "seen") return row.lastSeenAt.getTime();
  return row.level;
}

function itemOf(row: PlayerListRow, withPii: boolean, withPayments: boolean): PlayerListItem {
  return {
    accountId: row.accountId,
    platform: row.platform,
    displayName: row.displayName,
    photoUrl: row.photoUrl,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    level: row.level,
    source: row.source,
    campaign: row.campaign,
    payer: withPayments ? row.payer : null,
    canMessage: row.canMessage,
    banned: row.bannedAt === null ? null : { at: row.bannedAt.toISOString(), reason: row.banReason },
    pii: withPii ? { platformUserId: row.platformUserId, username: row.username } : null,
  };
}
