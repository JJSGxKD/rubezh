import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { NotificationsCleaner } from "../src/modules/notifications/notifications-cleaner.js";
import { FEED_PAGE_MAX, decodeCursor, encodeCursor } from "../src/modules/notifications/notifications.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { memoryNotifications } from "./helpers/memory-notifications.js";

// Лента уведомлений (docs/35-stage4-plan.md Р51, §3.17): одно событие — одно
// уведомление, данные — по схеме вида, лента — по курсору новыми сверху,
// прочитанное — до того, что игрок видел.

const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const FRIEND = { fromAccountId: OTHER, fromName: "Дым" };

describe("запись уведомления", () => {
  it("одно событие — одно уведомление: повтор по тому же ключу строки не заводит", async () => {
    const { service, repository } = memoryNotifications();
    expect(await service.notify({ accountId: ME, kind: "friend_gift", payload: FRIEND, dedupeKey: "friend_gift:x:2026-09-30" })).toBe(true);
    expect(await service.notify({ accountId: ME, kind: "friend_gift", payload: FRIEND, dedupeKey: "friend_gift:x:2026-09-30" })).toBe(false);
    expect(repository.of(ME)).toHaveLength(1);
  });

  it("данные не по схеме вида не пишутся — и не роняют действие, которое пишет", async () => {
    const { service, repository } = memoryNotifications();
    const broken = { fromAccountId: "не uuid", fromName: "" } as unknown as typeof FRIEND;
    expect(await service.notify({ accountId: ME, kind: "friend_request", payload: broken, dedupeKey: "k" })).toBe(false);
    expect(repository.of(ME)).toEqual([]);
  });

  it("сбой хранилища не бросает: подарок не должен отмениться из-за ленты", async () => {
    const { service, repository } = memoryNotifications();
    repository.insert = async () => {
      throw new Error("база недоступна");
    };
    await expect(service.notify({ accountId: ME, kind: "friend_gift", payload: FRIEND, dedupeKey: "k" })).resolves.toBe(false);
    expect(() => service.post({ accountId: ME, kind: "friend_gift", payload: FRIEND, dedupeKey: "k" })).not.toThrow();
  });
});

describe("лента", () => {
  async function seeded(count: number) {
    const notices = memoryNotifications();
    for (let index = 0; index < count; index++) {
      await notices.service.notify({ accountId: ME, kind: "friend_gift", payload: FRIEND, dedupeKey: `k${String(index)}`, at: new Date(Date.UTC(2026, 8, 1, 0, 0, index)) });
    }
    await notices.service.notify({ accountId: OTHER, kind: "friend_gift", payload: FRIEND, dedupeKey: "чужое" });
    return notices;
  }

  it("новые сверху, по курсору до конца без повторов и пропусков; чужого нет", async () => {
    const { service } = await seeded(7);
    const first = await service.feed(ME, undefined, 3);
    expect(first.items.map((item) => item.createdAt)).toEqual(["2026-09-01T00:00:06.000Z", "2026-09-01T00:00:05.000Z", "2026-09-01T00:00:04.000Z"]);
    expect(first.unread).toBe(7);
    const seen = [...first.items];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await service.feed(ME, cursor, 3);
      seen.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen.map((item) => item.id)).size).toBe(7);
  });

  it("страница — не больше потолка; вид, которого код не знает, и битые данные в ленту не попадают", async () => {
    const { service, repository } = await seeded(2);
    repository.rows.push({ accountId: ME, dedupeKey: "old", notificationId: "00000000-0000-4000-8000-00000000000a", kind: "season_result_v0", payload: {}, createdAt: new Date(), readAt: null });
    repository.rows.push({ accountId: ME, dedupeKey: "bad", notificationId: "00000000-0000-4000-8000-00000000000b", kind: "friend_gift", payload: { fromName: 5 }, createdAt: new Date(), readAt: null });
    const feed = await service.feed(ME, undefined, FEED_PAGE_MAX * 10);
    expect(feed.items.map((item) => item.kind)).toEqual(["friend_gift", "friend_gift"]);
  });

  it("прочитать до увиденного: пришедшее позже остаётся непрочитанным; без границы — всё", async () => {
    const { service } = await seeded(3);
    const feed = await service.feed(ME, undefined, 20);
    const middle = feed.items[1];
    expect(middle).toBeDefined();
    expect(await service.read(ME, middle?.id)).toEqual({ unread: 1 });
    expect(await service.read(ME, "00000000-0000-4000-8000-0000000000ff")).toEqual({ unread: 1 });
    expect(await service.read(ME, undefined)).toEqual({ unread: 0 });
    expect(await service.unread(OTHER)).toBe(1);
  });

  it("курсор — только свой формат: подделка — ошибка разбора, а не SQL", () => {
    const cursor = { createdAt: new Date(Date.UTC(2026, 8, 1)), notificationId: "00000000-0000-4000-8000-000000000001" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(() => decodeCursor(Buffer.from("1'; DROP TABLE notification; --").toString("base64url"))).toThrow(/курсор/);
    expect(() => decodeCursor("!!!")).toThrow(/курсор/);
  });
});

describe("срок хранения", () => {
  it("чистка удаляет старше 90 дней пачками, под локом, и молчит, если лок у другой реплики", async () => {
    const { service, repository } = memoryNotifications();
    const now = new Date(Date.UTC(2026, 8, 30));
    await service.notify({ accountId: ME, kind: "friend_gift", payload: FRIEND, dedupeKey: "old", at: new Date(now.getTime() - 91 * 86_400_000) });
    await service.notify({ accountId: ME, kind: "friend_gift", payload: FRIEND, dedupeKey: "fresh", at: new Date(now.getTime() - 89 * 86_400_000) });
    const locks = new Map<string, string>();
    const redis = {
      set: async (key: string, value: string) => (locks.has(key) ? null : (locks.set(key, value), "OK")),
      eval: async (_script: string, _keys: number, key: string) => (locks.delete(key) ? 1 : 0),
    };
    const cleaner = new NotificationsCleaner(loadAppConfig({ ...AUTH_ENV, NODE_ENV: "test" } as NodeJS.ProcessEnv), repository, redis as unknown as ConstructorParameters<typeof NotificationsCleaner>[2]);

    locks.set("notifications:purge:lock", "чужой");
    expect(await cleaner.tick(now)).toBeNull();
    locks.clear();
    expect(await cleaner.tick(now)).toBe(1);
    expect(repository.rows.map((row) => row.dedupeKey)).toEqual(["fresh"]);
  });
});
