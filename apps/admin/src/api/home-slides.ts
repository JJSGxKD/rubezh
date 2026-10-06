import { z } from "zod";
import { localInput } from "../format";
import type { AdminApi, ApiResult } from "./client";

/**
 * Слайды команды на главной (`/admin/home/slides`, docs/35-stage4-plan.md
 * WP42, часть 2) — под `home.edit`. Пределы и списки приходят с сервера
 * (`team-slide-rules.ts`); форма проверяет по ним то, что видно без базы.
 */

export const SLIDE_STATE_TITLES: Partial<Record<string, string>> = {
  scheduled: "будет",
  active: "идёт",
  ended: "кончился",
  archived: "снят",
};

/** Править и снимать можно то, что ещё не кончилось. */
export const EDITABLE: ReadonlySet<string> = new Set(["scheduled", "active"]);

/** Экраны игры — словами меню игры: так их называет и игрок. */
export const SCREEN_TITLES: Partial<Record<string, string>> = {
  shop: "Магазин",
  arsenal: "Арсенал",
  tasks: "Задания",
  rating: "Рейтинг",
  friends: "Друзья",
  wheel: "Колесо удачи",
  daily: "Награда дня",
  changelog: "Что нового",
  guide: "Гайдбук",
  profile: "Профиль",
  promoCode: "Ввод промокода",
};

export const ICON_TITLES: Partial<Record<string, string>> = {
  megaphone: "Объявление",
  trophy: "Турнир",
  gift: "Подарок",
  calendar: "Событие",
  sparkles: "Новинка",
};

export const AUDIENCE_TITLES: Partial<Record<string, { title: string; description: string }>> = {
  all: { title: "Все игроки", description: "кто открыл главную на отмеченных площадках" },
  newbies: { title: "Новички", description: "первые 7 суток после регистрации" },
  payers: { title: "Платившие", description: "хотя бы одна настоящая оплата, тестовая не в счёт" },
  nonpayers: { title: "Не платившие", description: "ни одной настоящей оплаты" },
  vip: { title: "С VIP", description: "пока подписка идёт" },
};

export const SLIDE_PLATFORMS = ["telegram", "max", "vk", "web"] as const;
export type SlidePlatform = (typeof SLIDE_PLATFORMS)[number];
export const SLIDE_PLATFORM_TITLES: Record<SlidePlatform, string> = { telegram: "Telegram", max: "MAX", vk: "VK", web: "Браузер" };

const targetSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("screen"), screen: z.string() }), z.object({ kind: z.literal("link"), url: z.string() })]);

const slideSchema = z.object({
  slideId: z.string(),
  title: z.string(),
  text: z.string(),
  imageId: z.string().nullable(),
  icon: z.string(),
  target: targetSchema,
  platforms: z.array(z.string()),
  audience: z.string(),
  pinned: z.boolean(),
  startsAt: z.string(),
  endsAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  state: z.string(),
});
export type TeamSlide = z.infer<typeof slideSchema>;

const limitsSchema = z.object({
  titleMax: z.number(),
  textMax: z.number(),
  maxDays: z.number(),
  aheadDays: z.number(),
  shownMax: z.number(),
  newbieDays: z.number(),
});
export type SlideLimits = z.infer<typeof limitsSchema>;

const catalogSchema = z.object({
  slides: z.array(slideSchema),
  limits: limitsSchema,
  screens: z.array(z.string()),
  icons: z.array(z.string()),
  audiences: z.array(z.string()),
});
export type SlideCatalog = z.infer<typeof catalogSchema>;

export interface SlideDraft {
  title: string;
  text: string;
  imageId: string | null;
  icon: string;
  targetKind: "screen" | "link";
  screen: string;
  url: string;
  platforms: SlidePlatform[];
  audience: string;
  pinned: boolean;
  /** пусто — начать сразу; иначе значение поля `datetime-local` в часах браузера */
  startsAt: string;
  /** значение поля `datetime-local` в часах браузера */
  endsAt: string;
}

const DAY_MS = 86_400_000;
/** Срок нового слайда по умолчанию: неделя — анонс успевают увидеть, но он не становится обоями. */
const DEFAULT_DAYS = 7;

export function emptyDraft(now: Date): SlideDraft {
  return {
    title: "",
    text: "",
    imageId: null,
    icon: "megaphone",
    targetKind: "screen",
    screen: "shop",
    url: "",
    platforms: [...SLIDE_PLATFORMS],
    audience: "all",
    pinned: false,
    startsAt: "",
    endsAt: localInput(new Date(now.getTime() + DEFAULT_DAYS * DAY_MS)),
  };
}

/** Черновик из сохранённого слайда — для правки: время — в часах браузера. */
export function draftOf(slide: TeamSlide): SlideDraft {
  return {
    title: slide.title,
    text: slide.text,
    imageId: slide.imageId,
    icon: slide.icon,
    targetKind: slide.target.kind,
    screen: slide.target.kind === "screen" ? slide.target.screen : "shop",
    url: slide.target.kind === "link" ? slide.target.url : "",
    platforms: SLIDE_PLATFORMS.filter((platform) => slide.platforms.includes(platform)),
    audience: slide.audience,
    pinned: slide.pinned,
    startsAt: localInput(new Date(slide.startsAt)),
    endsAt: localInput(new Date(slide.endsAt)),
  };
}

/** Одна строка без лишних пробелов — так её сохранит сервер и увидит игрок. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isHttps(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === "https:";
}

/**
 * Что не так с формой по пределам сервера; `null` — можно отправлять. Начало
 * в прошлом у идущего слайда — не ошибка: его правят, а не заводят заново.
 */
export function draftProblem(draft: SlideDraft, limits: SlideLimits, now: Date, editing: boolean): string | null {
  const title = oneLine(draft.title);
  const text = oneLine(draft.text);
  if (title === "") return "Напишите заголовок";
  if (title.length > limits.titleMax) return `Заголовок — не длиннее ${String(limits.titleMax)} знаков`;
  if (text === "") return "Напишите подпись";
  if (text.length > limits.textMax) return `Подпись — не длиннее ${String(limits.textMax)} знаков`;
  if (draft.targetKind === "link" && !isHttps(draft.url.trim())) return "Ссылка — целиком, с https://";
  if (draft.platforms.length === 0) return "Отметьте хотя бы одну площадку";
  const start = draft.startsAt === "" ? now : new Date(draft.startsAt);
  const end = new Date(draft.endsAt);
  if (Number.isNaN(start.getTime())) return "Некорректное начало";
  if (Number.isNaN(end.getTime())) return "Укажите конец";
  if (end <= start) return "Конец — позже начала";
  if (end <= now) return "Конец — в прошлом";
  if (!editing && draft.startsAt !== "" && start.getTime() < now.getTime() - 60_000) return "Начало — в прошлом: оставьте поле пустым, чтобы начать сразу";
  if (start.getTime() > now.getTime() + limits.aheadDays * DAY_MS) return `Заводите не дальше чем за ${String(limits.aheadDays)} дней`;
  if (end.getTime() - start.getTime() > limits.maxDays * DAY_MS) return `Слайд идёт не дольше ${String(limits.maxDays)} дней`;
  return null;
}

/** Время — в UTC: поле формы — в часах браузера, сервер считает в абсолютном времени. */
export function slideRequest(draft: SlideDraft, now: Date) {
  const start = draft.startsAt === "" ? now : new Date(draft.startsAt);
  return {
    title: oneLine(draft.title),
    text: oneLine(draft.text),
    imageId: draft.imageId,
    icon: draft.icon,
    target: draft.targetKind === "screen" ? { kind: "screen" as const, screen: draft.screen } : { kind: "link" as const, url: draft.url.trim() },
    platforms: draft.platforms,
    audience: draft.audience,
    pinned: draft.pinned,
    startsAt: start.toISOString(),
    endsAt: new Date(draft.endsAt).toISOString(),
  };
}

export function fetchSlides(api: AdminApi): Promise<ApiResult<SlideCatalog>> {
  return api.request("/home/slides", { schema: catalogSchema });
}

export function createSlide(api: AdminApi, draft: SlideDraft, now = new Date()): Promise<ApiResult<TeamSlide>> {
  return api.request("/home/slides", { method: "POST", body: slideRequest(draft, now), schema: slideSchema });
}

export function updateSlide(api: AdminApi, slideId: string, draft: SlideDraft, now = new Date()): Promise<ApiResult<TeamSlide>> {
  return api.request(`/home/slides/${encodeURIComponent(slideId)}`, { method: "POST", body: slideRequest(draft, now), schema: slideSchema });
}

export function archiveSlide(api: AdminApi, slideId: string): Promise<ApiResult<TeamSlide>> {
  return api.request(`/home/slides/${encodeURIComponent(slideId)}/archive`, { method: "POST", schema: slideSchema });
}

/** Куда ведёт — одной строкой для списка. */
export function targetLabel(slide: Pick<TeamSlide, "target">): string {
  return slide.target.kind === "screen" ? (SCREEN_TITLES[slide.target.screen] ?? slide.target.screen) : slide.target.url;
}

/** Кому и где — одной строкой для списка: «Новички · Telegram, VK». */
export function audienceLabel(slide: Pick<TeamSlide, "audience" | "platforms">): string {
  const who = AUDIENCE_TITLES[slide.audience]?.title ?? slide.audience;
  const where = slide.platforms.length === SLIDE_PLATFORMS.length ? "все площадки" : slide.platforms.map(platformTitle).join(", ");
  return `${who} · ${where}`;
}

/** Площадка словами; незнакомая — сервер новее панели — как записана. */
export function platformTitle(platform: string): string {
  const known = SLIDE_PLATFORMS.find((candidate) => candidate === platform);
  return known === undefined ? platform : SLIDE_PLATFORM_TITLES[known];
}

/**
 * Сколько идущих слайдов увидит игрок: разом — не больше `shownMax`. Больше —
 * команда должна знать, что лишние ждут своей очереди, а не «сломались».
 */
export function crowded(slides: readonly TeamSlide[], limits: SlideLimits): number {
  const running = slides.filter((slide) => slide.state === "active").length;
  return Math.max(0, running - limits.shownMax);
}
