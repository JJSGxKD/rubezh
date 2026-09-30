import { Injectable } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { ChangelogService } from "../changelog/changelog.service.js";
import { DailyService } from "../daily/daily.service.js";
import { FriendsService } from "../friends/friends.service.js";
import { ItemsService } from "../items/items.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import type { AccountRef } from "../roles/roles.service.js";
import { TasksService } from "../tasks/tasks.service.js";
import { WheelService } from "../wheel/wheel.service.js";

/**
 * Знаки меню одним ответом (docs/35-stage4-plan.md Р50, §3.17): новые
 * предметы, подарки и заявки друзей, непрочитанные уведомления. Знак —
 * только с полезной нагрузкой, числом: состояние меняется и с другого
 * устройства, поэтому считает сервер. Награда дня — единицей, пока её не
 * забрали в эти сутки. Журнал обновлений — числом версий, вышедших после
 * того, как игрок его открывал (WP31). Колесо — единицей, пока бесплатную
 * крутку этих суток не крутили. Задания — сколько наград можно забрать.
 */

const DB_TIMEOUT_MS = 3_000;

export interface BadgesView {
  /** новые предметы — лист ещё не открывали */
  arsenal: number;
  /** подарки, которые можно забрать сегодня, и заявки в друзья */
  friends: number;
  /** непрочитанные уведомления — число на колокольчике */
  notifications: number;
  /** награда дня ждёт: 1 — не забрана в эти сутки */
  daily: number;
  /** версии, вышедшие после того, как игрок открывал журнал обновлений */
  changelog: number;
  /** бесплатная крутка ждёт: 1 — в эти сутки колесо не крутили */
  wheel: number;
  /** выполненные задания и достижения, награду которых ещё не забрали */
  tasks: number;
}

@Injectable()
export class BadgesService {
  constructor(
    private readonly items: ItemsService,
    private readonly friends: FriendsService,
    private readonly notifications: NotificationsService,
    private readonly daily: DailyService,
    private readonly changelog: ChangelogService,
    private readonly wheel: WheelService,
    private readonly tasks: TasksService,
  ) {}

  async view(account: Pick<AccountRef, "accountId" | "platform">): Promise<BadgesView> {
    const { accountId } = account;
    const [arsenal, friends, notifications, daily, changelog, wheel, tasks] = await withTimeout(
      Promise.all([
        this.items.unseenCount(accountId),
        this.friends.badge(accountId),
        this.notifications.unread(accountId),
        this.daily.badge(accountId),
        this.changelog.badge(account),
        this.wheel.badge(accountId),
        this.tasks.badge(accountId),
      ]),
      DB_TIMEOUT_MS,
      "знаки меню",
    );
    return { arsenal, friends, notifications, daily, changelog, wheel, tasks };
  }
}
