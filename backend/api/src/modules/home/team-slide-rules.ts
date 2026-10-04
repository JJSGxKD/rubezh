import { z } from "zod";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";

/**
 * Слайды команды в карусели главной (docs/35-stage4-plan.md WP42, часть 2):
 * анонс турнира, новое оружие, конкурс в канале — то, о чём игрок узнаёт от
 * команды, а не из правила. Заводит и правит раздел панели «Главная» под
 * `home.edit`; правка видна игрокам сразу.
 *
 * Пределы держит и база (миграция `home_slide`): строка в обход сервиса не
 * заведёт слайд, который ведёт в никуда или не кончается.
 */
export const TEAM_SLIDE_LIMITS = {
  /** заголовок — одна строка: на телефоне шириной 320 целиком видно около 20 знаков */
  titleMax: 32,
  /** подпись — одна строка мельче заголовка */
  textMax: 40,
  /** дольше — слайд становится обоями, и его перестают замечать */
  maxDays: 60,
  /** дальше вперёд не заводится: к тому времени анонс устареет */
  aheadDays: 60,
  /** сколько слайдов команды разом в карусели: остальное место — слайдам по правилу */
  shownMax: 2,
  /** новичок — первые столько суток после регистрации */
  newbieDays: 7,
} as const;

/**
 * Куда может вести слайд: разделы нижней панели и экраны, которые
 * открываются с главной. Забег, настройки и инструменты команды — нет: в
 * забег ведёт «Играть», а остальное слайду не нужно.
 */
export const TEAM_SLIDE_SCREENS = ["shop", "arsenal", "tasks", "rating", "friends", "wheel", "daily", "changelog", "guide", "profile", "promoCode"] as const;
export type TeamSlideScreen = (typeof TEAM_SLIDE_SCREENS)[number];

/** Значок, когда картинки нет: объявление, подарок, турнир, событие, новинка. */
export const TEAM_SLIDE_ICONS = ["megaphone", "gift", "trophy", "calendar", "sparkles"] as const;
export type TeamSlideIcon = (typeof TEAM_SLIDE_ICONS)[number];

/**
 * Кому: всем, новичкам первых суток, платившим, не платившим, игрокам с VIP.
 * Платил — первая настоящая оплата, тестовая не считается (`account_funnel`).
 */
export const TEAM_SLIDE_AUDIENCES = ["all", "newbies", "payers", "nonpayers", "vip"] as const;
export type TeamSlideAudience = (typeof TEAM_SLIDE_AUDIENCES)[number];

export type TeamSlideTarget = { kind: "screen"; screen: TeamSlideScreen } | { kind: "link"; url: string };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** запас на часы панели: «начать сейчас» доходит до сервера через секунды */
const PAST_GRACE_MS = 5 * 60_000;

const moment = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

/** Одна строка без разметки: перевод строки и пробелы по краям в слайде ломают вёрстку. */
const line = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "пусто").max(max, `не длиннее ${String(max)} знаков`));

/** Ссылка — только https: `tg://` и `javascript:` клиент не откроет, а http — без шифрования. */
const httpsUrl = z
  .string()
  .trim()
  .max(256)
  .refine((value) => URL.canParse(value) && new URL(value).protocol === "https:", { message: "ссылка https://…" });

export const teamSlideInputSchema = z
  .object({
    title: line(TEAM_SLIDE_LIMITS.titleMax),
    text: line(TEAM_SLIDE_LIMITS.textMax),
    imageId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    icon: z.enum(TEAM_SLIDE_ICONS),
    target: z.discriminatedUnion("kind", [z.object({ kind: z.literal("screen"), screen: z.enum(TEAM_SLIDE_SCREENS) }).strict(), z.object({ kind: z.literal("link"), url: httpsUrl }).strict()]),
    platforms: z
      .array(z.enum(PLATFORM_IDS))
      .min(1, "хотя бы одна площадка")
      .max(PLATFORM_IDS.length)
      .transform((platforms) => [...new Set(platforms)]),
    audience: z.enum(TEAM_SLIDE_AUDIENCES),
    pinned: z.boolean(),
    startsAt: moment,
    endsAt: moment,
  })
  .strict();

export type TeamSlideInput = z.infer<typeof teamSlideInputSchema>;

export interface TeamSlideRow {
  slideId: string;
  title: string;
  text: string;
  imageId: string | null;
  icon: TeamSlideIcon;
  target: TeamSlideTarget;
  platforms: PlatformId[];
  audience: TeamSlideAudience;
  pinned: boolean;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
  archivedAt: Date | null;
  archivedBy: string | null;
}

/** Где слайд сейчас: в панели — колонкой, у игрока — только `active`. */
export type TeamSlideState = "scheduled" | "active" | "ended" | "archived";

export function teamSlideState(slide: Pick<TeamSlideRow, "startsAt" | "endsAt" | "archivedAt">, at: Date): TeamSlideState {
  if (slide.archivedAt !== null) return "archived";
  if (at < slide.startsAt) return "scheduled";
  return at < slide.endsAt ? "active" : "ended";
}

/**
 * Что не так со сроком; `null` — можно сохранять. У правки начало в прошлом
 * допустимо — слайд уже идёт, и сдвигать его начало ради правки текста
 * незачем; новый слайд в прошлом не начинается.
 */
export function teamSlidePeriodProblem(input: Pick<TeamSlideInput, "startsAt" | "endsAt">, at: Date, editing: boolean): string | null {
  const { startsAt, endsAt } = input;
  const now = at.getTime();
  if (endsAt <= startsAt) return "Конец — позже начала";
  if (endsAt.getTime() <= now) return "Слайд кончается в прошлом";
  if (!editing && startsAt.getTime() < now - PAST_GRACE_MS) return "Слайд не начинается в прошлом";
  if (startsAt.getTime() > now + TEAM_SLIDE_LIMITS.aheadDays * DAY_MS) return `Слайд заводят не дальше чем за ${String(TEAM_SLIDE_LIMITS.aheadDays)} дней`;
  if (endsAt.getTime() - startsAt.getTime() > TEAM_SLIDE_LIMITS.maxDays * DAY_MS) return `Слайд идёт не дольше ${String(TEAM_SLIDE_LIMITS.maxDays)} дней`;
  return null;
}

/** Что сервер знает об игроке для аудитории слайда. */
export interface AudienceFacts {
  platform: PlatformId;
  /** когда аккаунт зарегистрирован; `null` — не узнали, и слайд новичкам не показывается */
  createdAt: Date | null;
  /** первая настоящая оплата была; `null` — не узнали */
  payer: boolean | null;
  /** VIP идёт; `null` — не узнали */
  vip: boolean | null;
}

/**
 * Попадает ли игрок в аудиторию слайда. Не узнали факт — не показываем
 * слайд, которому он нужен: новичку чужой анонс «только для VIP» хуже, чем
 * не увидеть анонс вовсе.
 */
export function inAudience(slide: Pick<TeamSlideRow, "audience" | "platforms">, facts: AudienceFacts, at: Date): boolean {
  if (!slide.platforms.includes(facts.platform)) return false;
  switch (slide.audience) {
    case "all":
      return true;
    case "newbies":
      return facts.createdAt !== null && at.getTime() - facts.createdAt.getTime() < TEAM_SLIDE_LIMITS.newbieDays * DAY_MS;
    case "payers":
      return facts.payer === true;
    case "nonpayers":
      return facts.payer === false;
    case "vip":
      return facts.vip === true;
  }
}

/**
 * Какие слайды команды показать игроку: идущие, его площадки и аудитории,
 * закреплённые первыми, дальше — начавшиеся позже; не больше `shownMax`.
 */
export function teamSlidesFor(slides: readonly TeamSlideRow[], facts: AudienceFacts, at: Date): TeamSlideRow[] {
  return slides
    .filter((slide) => teamSlideState(slide, at) === "active" && inAudience(slide, facts, at))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.startsAt.getTime() - a.startsAt.getTime())
    .slice(0, TEAM_SLIDE_LIMITS.shownMax);
}
