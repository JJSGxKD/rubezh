import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { HOME_SLIDES_MAX, partnerTaskOfDay, pickSlides, type HomeSources } from "../src/modules/home/home-slides.js";
import { HomeService } from "../src/modules/home/home.service.js";
import type { ChangelogService } from "../src/modules/changelog/changelog.service.js";
import type { AccountRestrictions } from "../src/modules/restrictions/account-restrictions.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import type { ShopItemView, ShopService } from "../src/modules/shop/shop.service.js";
import type { TaskView, TasksService } from "../src/modules/tasks/tasks.service.js";
import type { VipService } from "../src/modules/vip/vip.service.js";

/**
 * Карусель главной (docs/35-stage4-plan.md WP42): порядок — по ценности для
 * игрока, не больше пяти; купить то, что нельзя купить, не зовём; источник,
 * который не ответил, теряет свой слайд, а не всю карусель.
 */

const NOW = new Date("2026-10-04T12:00:00.000Z");
const HOUR = 3_600_000;

function item(patch: Partial<ShopItemView> = {}): ShopItemView {
  return { sku: "gems_s", kind: "gems", contents: [], stars: 50, fullStars: null, promo: null, chargedStars: 50, once: false, owned: false, badge: null, valuePct: null, ...patch };
}

function task(patch: Partial<TaskView> = {}): TaskView {
  return {
    id: "channel_news",
    period: "achievement",
    category: "partner",
    kind: "channel",
    title: "Подпишись на канал партнёра",
    target: 1,
    value: 0,
    done: false,
    claimed: false,
    reward: { coins: 100, gems: 0, shards: 0 },
    passPoints: 0,
    link: "https://t.me/partner",
    slots: null,
    image: null,
    ...patch,
  };
}

function sources(patch: Partial<HomeSources> = {}): HomeSources {
  return { shop: { items: [] }, vip: null, freshVersions: 0, invite: false, channelUrl: "", tasks: [], ...patch };
}

const promo = (percent: number, hours: number) => ({ percent, endsAt: new Date(NOW.getTime() + hours * HOUR), title: null });

describe("слайды главной", () => {
  it("по ценности: акция, новое в версии, VIP, стартовый набор, друзья, канал, задание — и не больше пяти", () => {
    const all = sources({
      shop: { items: [item({ sku: "bundle_m", kind: "bundle", promo: promo(30, 5) }), item({ sku: "starter", kind: "starter", once: true, stars: 25 })] },
      vip: { active: false, canOrder: true, stars: 700 },
      freshVersions: 2,
      invite: true,
      channelUrl: "https://t.me/rubezh",
      tasks: [task()],
    });
    const slides = pickSlides(all, NOW);
    expect(slides.map((slide) => slide.kind)).toEqual(["promo", "changelog", "vip", "starter", "invite"]);
    expect(slides).toHaveLength(HOME_SLIDES_MAX);
    expect(slides[0]).toEqual({ id: "promo:bundle_m", kind: "promo", sku: "bundle_m", percent: 30, endsAt: new Date(NOW.getTime() + 5 * HOUR).toISOString(), title: null });

    // Без лишнего — до канала и задания доходит очередь.
    expect(pickSlides(sources({ invite: true, channelUrl: "https://t.me/rubezh", tasks: [task()] }), NOW).map((slide) => slide.id)).toEqual(["invite", "channel", "task:channel_news"]);
  });

  it("акция — самая щедрая, при равной — та, что кончится раньше; кончившаяся и некупимая — не акция", () => {
    const items = [item({ sku: "a", promo: promo(20, 10) }), item({ sku: "b", promo: promo(40, 10) }), item({ sku: "c", promo: promo(40, 2) }), item({ sku: "d", promo: promo(90, -1) }), item({ sku: "e", stars: null, promo: promo(95, 5) })];
    expect(pickSlides(sources({ shop: { items } }), NOW)[0]?.id).toBe("promo:c");
  });

  it("стартовый набор — пока не куплен и только где есть оплата; по акции — одним слайдом акции", () => {
    const starter = (patch: Partial<ShopItemView>) => sources({ shop: { items: [item({ sku: "starter", kind: "starter", once: true, ...patch })] } });
    expect(pickSlides(starter({}), NOW).map((slide) => slide.kind)).toEqual(["starter"]);
    expect(pickSlides(starter({ owned: true }), NOW)).toEqual([]);
    expect(pickSlides(starter({ stars: null }), NOW)).toEqual([]);
    expect(pickSlides(starter({ promo: promo(50, 3) }), NOW).map((slide) => slide.kind)).toEqual(["promo"]);
  });

  it("VIP — пока его нет и его можно оформить на этой площадке", () => {
    const vip = (patch: Partial<NonNullable<HomeSources["vip"]>>) => pickSlides(sources({ vip: { active: false, canOrder: true, stars: 700, ...patch } }), NOW);
    expect(vip({})).toEqual([{ id: "vip", kind: "vip", stars: 700 }]);
    expect(vip({ active: true })).toEqual([]);
    expect(vip({ canOrder: false })).toEqual([]);
    expect(vip({ stars: null })).toEqual([]);
  });

  it("задание дня — партнёрское, не выполненное и с местами; задания забега и разобранные — нет", () => {
    expect(partnerTaskOfDay([task({ category: "daily", kind: "runs" }), task({ id: "a", done: true }), task({ id: "b", slots: { left: 0, total: 100, holdUntil: null } }), task({ id: "c" })])?.id).toBe("c");
    expect(partnerTaskOfDay([task({ claimed: true, done: true })])).toBeNull();
  });
});

const account: AccountRef = { accountId: "8f7c1c1e-7f0a-4b8e-9d7e-1c2b3a4d5e6f", platform: "telegram", platformUserId: "700" };

function service(patch: { shop?: () => Promise<unknown>; tasks?: () => Promise<TaskView[]>; restricted?: readonly string[]; channel?: string } = {}): HomeService {
  const shop = { view: patch.shop ?? (async () => ({ items: [item({ sku: "starter", kind: "starter", once: true })] })) } as unknown as ShopService;
  const vip = { view: async () => ({ active: false, canOrder: true, stars: 700 }) } as unknown as VipService;
  const changelog = { badge: async () => 0 } as unknown as ChangelogService;
  const tasks = { view: patch.tasks ?? (async () => [task()]) } as unknown as TasksService;
  const restrictions = { status: async (_id: string, kind: string) => ((patch.restricted ?? []).includes(kind) ? { kind } : null) } as unknown as AccountRestrictions;
  const settings: SettingsReader = { get: (setting) => (setting.key === SETTINGS.homeChannelUrl.key ? (patch.channel ?? "") : setting.fallback) as never, onChange: () => undefined };
  return new HomeService(shop, vip, changelog, tasks, restrictions, settings);
}

describe("главная в сервисе", () => {
  it("собирает слайды из соседей; канал — из настроек", async () => {
    const view = await service({ channel: "https://t.me/rubezh" }).view(account, NOW);
    expect(view.slides.map((slide) => slide.id)).toEqual(["vip", "starter", "invite", "channel", "task:channel_news"]);
  });

  it("не ответил магазин — без акции и набора, остальное на месте", async () => {
    const view = await service({ shop: async () => Promise.reject(new Error("база недоступна")) }).view(account, NOW);
    expect(view.slides.map((slide) => slide.kind)).toEqual(["vip", "invite", "task"]);
  });

  it("под ограничениями — без приглашения друзей и без партнёрского задания", async () => {
    const view = await service({ restricted: ["referral_rewards", "partner_tasks"] }).view(account, NOW);
    expect(view.slides.map((slide) => slide.kind)).toEqual(["vip", "starter"]);
  });
});
