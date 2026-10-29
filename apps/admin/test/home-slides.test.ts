import { describe, expect, it } from "vitest";
import { auditChanges, auditObject, auditValue } from "../src/api/audit";
import { AdminApi } from "../src/api/client";
import {
  archiveSlide,
  audienceLabel,
  createSlide,
  crowded,
  draftOf,
  draftProblem,
  emptyDraft,
  fetchSlides,
  reorderSlides,
  slideGroups,
  slideRequest,
  targetLabel,
  slideSchema,
  updateSlide,
  type SlideDraft,
  type SlideLimits,
  type TeamSlide,
} from "../src/api/home-slides";
import { localInput } from "../src/format";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Слайды команды на главной (docs/35-stage4-plan.md WP42, часть 2): форма
// проверяет пределы сервера, время уходит в UTC, список и журнал говорят
// словами, а не кодами.

const LIMITS: SlideLimits = { titleMax: 32, textMax: 40, maxDays: 60, aheadDays: 60, shownMax: 2, newbieDays: 7 };
const NOW = new Date(Date.UTC(2026, 9, 4, 9));
const DAY = 86_400_000;
const ID = "0c4a5c1e-6a57-4d43-8a2a-0f3f6d0a9b10";

function draft(patch: Partial<SlideDraft> = {}): SlideDraft {
  return { ...emptyDraft(NOW), title: "Турнир выходного дня", text: "Лучшее время — в рейтинге", ...patch };
}

function slide(patch: Partial<TeamSlide> = {}): TeamSlide {
  return {
    slideId: ID,
    title: "Турнир",
    text: "Призы — самоцветы",
    imageId: null,
    icon: "trophy",
    target: { kind: "screen", screen: "rating" },
    platforms: ["telegram", "vk"],
    audience: "newbies",
    pinned: false,
    position: 0,
    startsAt: NOW.toISOString(),
    endsAt: new Date(NOW.getTime() + 3 * DAY).toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    archivedAt: null,
    state: "active",
    ...patch,
  };
}

describe("слайды команды в панели", () => {
  it("раздел — под своим правом", () => {
    expect(SECTIONS.find((section) => section.id === "home")?.permission).toBe("home.edit");
  });

  it("новый слайд — на неделю, на всех площадках, всем, значок объявления", () => {
    const empty = emptyDraft(NOW);
    expect(empty).toMatchObject({ startsAt: "", endsAt: localInput(new Date(NOW.getTime() + 7 * DAY)), platforms: ["telegram", "max", "vk", "web"], audience: "all", icon: "megaphone", targetKind: "screen" });
  });

  it("список, заведение, правка и снятие — по своим адресам; строки — без лишних пробелов, «сразу» — время отправки", async () => {
    const catalog = { slides: [slide()], limits: LIMITS, screens: ["shop", "rating"], icons: ["megaphone", "trophy"], audiences: ["all", "newbies"] };
    const { fetch, calls } = fakeFetch(json(200, { data: catalog }), json(201, { data: slide() }), json(201, { data: slide() }), json(201, { data: slide({ state: "archived" }) }));
    const api = new AdminApi(fetch);
    const list = await fetchSlides(api);
    expect(list.ok && list.data.slides[0]?.title).toBe("Турнир");
    expect(calls[0]?.url).toBe("/api/v1/admin/home/slides");

    await createSlide(api, draft({ title: "  Турнир \n выходного  дня ", targetKind: "link", url: " https://t.me/rubezh " }), NOW);
    expect(calls[1]?.url).toBe("/api/v1/admin/home/slides");
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({
      title: "Турнир выходного дня",
      target: { kind: "link", url: "https://t.me/rubezh" },
      startsAt: NOW.toISOString(),
      platforms: ["telegram", "max", "vk", "web"],
    });
    // Место слайда уходит только запросом порядка: ни в заведении, ни в правке его нет.
    expect(JSON.parse(String(calls[1]?.init.body))).not.toHaveProperty("position");

    await updateSlide(api, ID, draft(), NOW);
    expect(JSON.parse(String(calls[2]?.init.body))).not.toHaveProperty("position");
    expect([calls[2]?.url, calls[2]?.init.method]).toEqual([`/api/v1/admin/home/slides/${ID}`, "POST"]);
    const archived = await archiveSlide(api, ID);
    expect(archived.ok && archived.data.state).toBe("archived");
    expect(calls[3]?.url).toBe(`/api/v1/admin/home/slides/${ID}/archive`);
  });

  it("ответ списка несёт место слайда; без него — не слайд", () => {
    expect(slideSchema.safeParse(slide({ position: 3 })).success).toBe(true);
    const { position: _position, ...without } = slide();
    expect(slideSchema.safeParse(without).success).toBe(false);
  });

  it("новый порядок: POST /home/slides/order с группой и id, ответ разобран; ответ другой формы — ошибка", async () => {
    const { fetch, calls } = fakeFetch(json(201, { data: { order: ["b", "a"] } }), json(201, { data: { order: "b,a" } }));
    const api = new AdminApi(fetch);
    const ok = await reorderSlides(api, "regular", ["b", "a"]);
    expect(ok.ok && ok.data.order).toEqual(["b", "a"]);
    expect([calls[0]?.url, calls[0]?.init.method]).toEqual(["/api/v1/admin/home/slides/order", "POST"]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ group: "regular", ids: ["b", "a"] });
    expect((await reorderSlides(api, "pinned", ["a"])).ok).toBe(false);
  });

  it("группы списка: закреплённые, остальные и снятые; порядок как в ответе; кончившийся остаётся в своей группе", () => {
    const list = [
      slide({ slideId: "p1", pinned: true }),
      slide({ slideId: "r1" }),
      slide({ slideId: "e1", state: "ended" }),
      slide({ slideId: "p2", pinned: true, state: "scheduled" }),
      slide({ slideId: "x1", state: "archived", archivedAt: NOW.toISOString() }),
      slide({ slideId: "x2", pinned: true, state: "archived", archivedAt: NOW.toISOString() }),
    ];
    const groups = slideGroups(list);
    expect(groups.pinned.map((item) => item.slideId)).toEqual(["p1", "p2"]);
    expect(groups.regular.map((item) => item.slideId)).toEqual(["r1", "e1"]);
    expect(groups.archived.map((item) => item.slideId)).toEqual(["x1", "x2"]);
    expect(slideGroups([])).toEqual({ pinned: [], regular: [], archived: [] });
  });

  it("правка начинается с сохранённого: время — в часах браузера, цель и площадки — как были", () => {
    const saved = slide({ target: { kind: "link", url: "https://t.me/rubezh" } });
    const editing = draftOf(saved);
    expect(editing).toMatchObject({ targetKind: "link", url: "https://t.me/rubezh", platforms: ["telegram", "vk"], audience: "newbies", startsAt: localInput(NOW) });
    expect(slideRequest(editing, NOW).endsAt).toBe(new Date(localInput(new Date(saved.endsAt))).toISOString());
  });

  it("форма не пропустит пустое, длинное, ссылку не https, слайд без площадки и срок вне пределов", () => {
    expect(draftProblem(draft(), LIMITS, NOW, false)).toBeNull();
    expect(draftProblem(draft({ title: "   " }), LIMITS, NOW, false)).toMatch(/заголовок/);
    expect(draftProblem(draft({ title: "я".repeat(33) }), LIMITS, NOW, false)).toMatch(/32/);
    expect(draftProblem(draft({ text: "я".repeat(41) }), LIMITS, NOW, false)).toMatch(/40/);
    for (const url of ["", "t.me/rubezh", "http://t.me/rubezh", "javascript:alert(1)"]) {
      expect(draftProblem(draft({ targetKind: "link", url }), LIMITS, NOW, false), url).toMatch(/https/);
    }
    expect(draftProblem(draft({ platforms: [] }), LIMITS, NOW, false)).toMatch(/площадку/);
    expect(draftProblem(draft({ endsAt: localInput(new Date(NOW.getTime() - DAY)) }), LIMITS, NOW, false)).toMatch(/Конец/);
    expect(draftProblem(draft({ endsAt: localInput(new Date(NOW.getTime() + 61 * DAY)) }), LIMITS, NOW, false)).toMatch(/60 дней/);
    expect(draftProblem(draft({ startsAt: localInput(new Date(NOW.getTime() + 61 * DAY)), endsAt: localInput(new Date(NOW.getTime() + 62 * DAY)) }), LIMITS, NOW, false)).toMatch(/60 дней/);
  });

  it("начало в прошлом: у нового — подсказка оставить пустым, у идущего при правке — не ошибка", () => {
    const past = draft({ startsAt: localInput(new Date(NOW.getTime() - DAY)) });
    expect(draftProblem(past, LIMITS, NOW, false)).toMatch(/пустым/);
    expect(draftProblem(past, LIMITS, NOW, true)).toBeNull();
  });

  it("список словами: куда ведёт, кому и где; больше двух идущих — предупреждение", () => {
    expect(targetLabel(slide())).toBe("Рейтинг");
    expect(targetLabel(slide({ target: { kind: "link", url: "https://t.me/rubezh" } }))).toBe("https://t.me/rubezh");
    expect(audienceLabel(slide())).toBe("Новички · Telegram, VK");
    expect(audienceLabel(slide({ audience: "all", platforms: ["telegram", "max", "vk", "web"] }))).toBe("Все игроки · все площадки");
    expect(crowded([slide(), slide({ slideId: "b" }), slide({ slideId: "c", state: "scheduled" })], LIMITS)).toBe(0);
    expect(crowded([slide(), slide({ slideId: "b" }), slide({ slideId: "c" })], LIMITS)).toBe(1);
  });

  it("журнал: слайд по названию со ссылкой на раздел, поля и значения — словами", () => {
    const entry = {
      entryId: "1",
      createdAt: NOW.toISOString(),
      actorAccountId: "a",
      actorName: "Маркетолог",
      action: "home.slide.update",
      target: ID,
      targetName: null,
      before: { title: "Турнир", screen: "rating", link: null, forWhom: "newbies", pinned: false, image: null },
      after: { title: "Турнир", screen: null, link: "https://t.me/rubezh", forWhom: "vip", pinned: true, image: "a".repeat(64) },
    };
    expect(auditObject(entry)).toEqual({ kind: "слайд главной", label: "Турнир", route: { section: "home", id: null } });
    expect(auditChanges(entry).map((change) => change.field)).toEqual(["image", "screen", "link", "forWhom", "pinned"]);
    expect([auditValue("rating", "screen"), auditValue("vip", "forWhom"), auditValue("trophy", "icon")]).toEqual(["Рейтинг", "С VIP", "Турнир"]);
  });
});
