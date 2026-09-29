import { Injectable } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { FriendsService } from "../friends/friends.service.js";
import { ItemsService } from "../items/items.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";

/**
 * Знаки меню одним ответом (docs/35-stage4-plan.md Р50, §3.17): новые
 * предметы, подарки и заявки друзей, непрочитанные уведомления. Знак —
 * только с полезной нагрузкой, числом: состояние меняется и с другого
 * устройства, поэтому считает сервер. Задания к выдаче придут с WP13.
 */

const DB_TIMEOUT_MS = 3_000;

export interface BadgesView {
  /** новые предметы — лист ещё не открывали */
  arsenal: number;
  /** подарки, которые можно забрать сегодня, и заявки в друзья */
  friends: number;
  /** непрочитанные уведомления — число на колокольчике */
  notifications: number;
}

@Injectable()
export class BadgesService {
  constructor(
    private readonly items: ItemsService,
    private readonly friends: FriendsService,
    private readonly notifications: NotificationsService,
  ) {}

  async view(accountId: string): Promise<BadgesView> {
    const [arsenal, friends, notifications] = await withTimeout(
      Promise.all([this.items.unseenCount(accountId), this.friends.badge(accountId), this.notifications.unread(accountId)]),
      DB_TIMEOUT_MS,
      "знаки меню",
    );
    return { arsenal, friends, notifications };
  }
}
