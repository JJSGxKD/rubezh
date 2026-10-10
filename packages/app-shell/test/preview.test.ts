import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { trustedMessage } from "../src/preview";
import { draftMessageSchema, PREVIEW_DRAFT, type TaskDraft } from "../src/preview/protocol";
import { changelogVersion, PREVIEW_REGISTRY, taskStates } from "../src/preview/registry";

// Страница предпросмотра для панели (docs/35-stage4-plan.md WP32, Р83):
// черновик — только от панели и только от окна, в которое она встроена;
// реестр рисует черновик без сети тем же слайдом, что игрок.

const PANEL = "https://admin.gonet.fun";
const parent = {};
const IMAGE = "a".repeat(64);

describe("сообщения панели", () => {
  it("принимаются от адреса панели и от родительского окна — чужой адрес и чужое окно мимо", () => {
    expect(trustedMessage({ origin: PANEL, source: parent as MessageEventSource }, [PANEL], parent)).toBe(true);
    expect(trustedMessage({ origin: "https://evil.example", source: parent as MessageEventSource }, [PANEL], parent)).toBe(false);
    expect(trustedMessage({ origin: PANEL, source: {} as MessageEventSource }, [PANEL], parent)).toBe(false);
    // Адрес панели не задан — не принимается ничего.
    expect(trustedMessage({ origin: PANEL, source: parent as MessageEventSource }, [], parent)).toBe(false);
  });

  it("черновик — своим именем и известного вида; чужое сообщение на странице не похоже на него", () => {
    expect(draftMessageSchema.safeParse({ type: PREVIEW_DRAFT, kind: "home-slide", draft: {} }).success).toBe(true);
    expect(draftMessageSchema.safeParse({ type: PREVIEW_DRAFT, kind: "lottery", draft: {} }).success).toBe(false);
    expect(draftMessageSchema.safeParse({ type: "webpackOk" }).success).toBe(false);
  });
});

describe("реестр предпросмотра", () => {
  const render = (draft: unknown) => PREVIEW_REGISTRY["home-slide"].render(draft, { apiBaseUrl: "https://api.gonet.fun" });

  it("слайд главной — словами черновика, значком и картинкой с адреса API, рядом — сосед и точки", () => {
    const html = renderToStaticMarkup(render({ title: "Турнир выходного дня", text: "Призы — самоцветы", imageId: IMAGE, icon: "trophy" }));
    expect(html).toContain("Турнир выходного дня");
    expect(html).toContain("Призы — самоцветы");
    expect(html).toContain(`https://api.gonet.fun/api/v1/media/${IMAGE}.webp`);
    expect(html).toContain("Позови друзей");
    expect(html.match(/aria-current/g)).toHaveLength(2);
  });

  it("пустые поля — подписями-заготовками, без картинки — значок; битый черновик — ничего", () => {
    const html = renderToStaticMarkup(render({ title: "", text: " ", imageId: null, icon: "gift" }));
    expect(html).toContain("Заголовок");
    expect(html).toContain("Подпись");
    expect(html).not.toContain("<img");
    expect(render({ title: "т", text: "п", imageId: "../../etc/passwd", icon: "gift" })).toBeNull();
    expect(render("мусор")).toBeNull();
  });
});

describe("версия журнала в предпросмотре", () => {
  const render = (draft: unknown) => PREVIEW_REGISTRY["changelog-version"].render(draft, { apiBaseUrl: "https://api.gonet.fun" });

  it("карточкой «Что нового»: номер, строки по видам, новая", () => {
    const html = renderToStaticMarkup(render({ version: "0.6.0", entries: [{ kind: "fixed", text: "Колесо не зависает" }, { kind: "added", text: "Виджеты главной" }] }));
    expect(html).toContain("0.6.0");
    expect(html).toContain("Виджеты главной");
    expect(html).toContain("Колесо не зависает");
    // Новое — раньше исправленного, как у игрока.
    expect(html.indexOf("Виджеты главной")).toBeLessThan(html.indexOf("Колесо не зависает"));
  });

  it("пустая версия и пустые строки — заготовками; битый черновик — ничего", () => {
    const version = changelogVersion({ version: " ", entries: [{ kind: "added", text: "  " }] }, new Date("2026-10-04T12:00:00.000Z"));
    expect(version).toMatchObject({ version: "x.y.z", fresh: true, entries: [{ kind: "added", text: "Строка журнала" }] });
    expect(render({ version: "0.6.0", entries: "мусор" })).toBeNull();
  });
});

describe("задание в предпросмотре", () => {
  const draft: TaskDraft = { title: null, kind: "runs", period: "daily", partner: false, target: 3, reward: { coins: 50, gems: 0, shards: 2 }, imageId: null, link: null };
  const render = (value: unknown) => PREVIEW_REGISTRY.task.render(value, { apiBaseUrl: "https://api.gonet.fun" });

  it("двумя строками: до выполнения с нулевым прогрессом и выполненным — с «Забрать»", () => {
    const { before, after } = taskStates(draft);
    expect([before.value, before.done, after.value, after.done]).toEqual([0, false, 3, true]);
    expect(before.category).toBe("daily");
    const html = renderToStaticMarkup(render(draft));
    expect(html).toContain("Пока не выполнено");
    expect(html).toContain("Забрать");
  });

  it("партнёрская цель — своей вкладкой, с картинкой с адреса API; заголовок — как набран", () => {
    const partner: TaskDraft = { ...draft, title: "  Подпишись на канал  ", kind: "channel", period: "achievement", partner: true, target: 1, imageId: IMAGE, link: "https://t.me/rubezh" };
    expect(taskStates(partner).before).toMatchObject({ category: "partner", title: "Подпишись на канал", link: "https://t.me/rubezh" });
    const html = renderToStaticMarkup(render(partner));
    expect(html).toContain(`https://api.gonet.fun/api/v1/media/${IMAGE}.webp`);
    expect(html).toContain("Подписаться");
  });

  it("битый черновик — ничего: картинка не путь медиа, отрицательная награда", () => {
    expect(render({ ...draft, imageId: "../x" })).toBeNull();
    expect(render({ ...draft, reward: { coins: -1, gems: 0, shards: 0 } })).toBeNull();
  });
});
