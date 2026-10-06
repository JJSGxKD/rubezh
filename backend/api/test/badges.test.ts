import { describe, expect, it } from "vitest";
import { BadgesService } from "../src/modules/badges/badges.service.js";
import type { ChangelogService } from "../src/modules/changelog/changelog.service.js";
import type { DailyService } from "../src/modules/daily/daily.service.js";
import type { FriendsService } from "../src/modules/friends/friends.service.js";
import type { ItemsService } from "../src/modules/items/items.service.js";
import type { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import type { TasksService } from "../src/modules/tasks/tasks.service.js";
import type { WheelService } from "../src/modules/wheel/wheel.service.js";

// Знаки меню одним ответом (docs/35-stage4-plan.md Р50): числа соседних
// модулей — своему аккаунту, без собственных данных.

const daily = (value: number, asked: string[] = []) => ({ badge: async (id: string) => (asked.push(`daily:${id}`), value) }) as unknown as DailyService;
const changelog = (value: number, asked: string[] = []) =>
  ({ badge: async (account: { accountId: string; platform: string }) => (asked.push(`changelog:${account.accountId}:${account.platform}`), value) }) as unknown as ChangelogService;
const wheel = (value: number, asked: string[] = []) => ({ badge: async (id: string) => (asked.push(`wheel:${id}`), value) }) as unknown as WheelService;
const tasks = (value: number, asked: string[] = []) => ({ badge: async (id: string) => (asked.push(`tasks:${id}`), value) }) as unknown as TasksService;
const ME = { accountId: "me", platform: "telegram" } as const;

describe("знаки меню", () => {
  it("собирает новые предметы, друзей, непрочитанное, награду дня, журнал, колесо и задания одним ответом — по аккаунту спросившего", async () => {
    const asked: string[] = [];
    const items = { unseenCount: async (id: string) => (asked.push(`items:${id}`), 2) } as unknown as ItemsService;
    const friends = { badge: async (id: string) => (asked.push(`friends:${id}`), 3) } as unknown as FriendsService;
    const notifications = { unread: async (id: string) => (asked.push(`notifications:${id}`), 1) } as unknown as NotificationsService;

    expect(await new BadgesService(items, friends, notifications, daily(1, asked), changelog(2, asked), wheel(1, asked), tasks(4, asked)).view(ME)).toEqual({
      arsenal: 2,
      friends: 3,
      notifications: 1,
      daily: 1,
      changelog: 2,
      wheel: 1,
      tasks: 4,
    });
    expect(asked.sort()).toEqual(["changelog:me:telegram", "daily:me", "friends:me", "items:me", "notifications:me", "tasks:me", "wheel:me"]);
  });

  it("сбой одного счётчика — ошибка ответа, а не молча ноль: клиент оставит прежние знаки", async () => {
    const items = { unseenCount: async () => 1 } as unknown as ItemsService;
    const friends = {
      badge: async () => {
        throw new Error("база недоступна");
      },
    } as unknown as FriendsService;
    const notifications = { unread: async () => 0 } as unknown as NotificationsService;
    await expect(new BadgesService(items, friends, notifications, daily(0), changelog(0), wheel(0), tasks(0)).view(ME)).rejects.toThrow(/база недоступна/);
  });
});
