import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";

/**
 * Карусель главной (docs/35-stage4-plan.md WP42): что показать и в каком
 * порядке, решает сервер (`GET /api/v1/me/home`), клиент только рисует.
 * Незнакомый вид слайда — сервер новее клиента — отбрасывается по одному, а
 * не роняет всю карусель. Разбирается только то, что карусель рисует: слайд
 * ведёт на экран целиком, а не к товару или заданию.
 *
 * Модуль едет с чанком карусели — первой загрузке он не нужен.
 */

const rewardSchema = z.object({ coins: z.number(), gems: z.number(), shards: z.number() });

/**
 * Куда ведёт слайд команды — экраны, которые клиент умеет открыть. Экран,
 * которого клиент не знает (сервер новее), отбрасывает слайд: вести его
 * некуда.
 */
export const TEAM_SLIDE_SCREENS = ["shop", "arsenal", "tasks", "rating", "friends", "wheel", "daily", "changelog", "guide", "profile", "promoCode"] as const;

const teamTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screen"), screen: z.enum(TEAM_SLIDE_SCREENS) }),
  z.object({ kind: z.literal("link"), url: z.string() }),
]);

const slideSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("promo"), percent: z.number(), endsAt: z.string(), title: z.nullable(z.string()) }),
  z.object({ id: z.string(), kind: z.literal("changelog"), versions: z.number() }),
  z.object({ id: z.string(), kind: z.literal("vip"), stars: z.number() }),
  z.object({ id: z.string(), kind: z.literal("starter"), stars: z.number() }),
  z.object({ id: z.string(), kind: z.literal("invite") }),
  z.object({ id: z.string(), kind: z.literal("channel"), url: z.string() }),
  z.object({ id: z.string(), kind: z.literal("task"), title: z.nullable(z.string()), image: z.nullable(z.string()), reward: rewardSchema }),
  // Значок — строкой: незнакомый (сервер новее) рисуется значком объявления, а не роняет слайд.
  z.object({ id: z.string(), kind: z.literal("team"), slideId: z.string(), title: z.string(), text: z.string(), image: z.nullable(z.string()), icon: z.string(), target: teamTargetSchema }),
]);

export type HomeSlide = z.infer<typeof slideSchema>;

/** Слайды разбираются по одному: незнакомый вид не должен стоить всей карусели. */
const viewSchema = z.object({ slides: z.array(z.unknown()) });

export interface HomeApi {
  slides(): Promise<ApiResult<HomeSlide[]>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createHomeApi(request: ApiRequest = apiRequest): HomeApi {
  return {
    async slides() {
      const response = await request("/api/v1/me/home", viewSchema, { method: "GET" });
      if (!response.ok) return response;
      return { ok: true, data: response.data.slides.flatMap((raw) => {
        const parsed = slideSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      }) };
    },
  };
}

/**
 * Картинка партнёрского задания и слайда команды — путь от адреса API, ровно
 * такой отдаёт сервер (`media/image-rules.ts`); иначе — значок вида. То же правило, что
 * у экрана заданий, но своей строкой: общий модуль стал бы ещё одним чанком
 * в списке предзагрузки первой загрузки.
 */
const IMAGE_PATH = /^\/api\/v1\/media\/[0-9a-f]{64}\.webp$/;

export function slideImageUrl(path: string | null, baseUrl: string | undefined): string | null {
  if (path === null || baseUrl === undefined || !IMAGE_PATH.test(path)) return null;
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Ссылка канала — только `https`: сервер её проверил, но клиент не открывает `javascript:` ни от кого. */
export function safeLink(url: string): string | null {
  return URL.canParse(url) && new URL(url).protocol === "https:" ? url : null;
}

/** Карусель — только с входом: слайды собраны по аккаунту. */
export function homeAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}

/**
 * Сколько ответ считается свежим: на главную возвращаются после каждого
 * забега, и карусель не должна мигать заглушкой. Новое в версии и купленный
 * набор подождут минуту.
 */
export const HOME_FRESH_MS = 60_000;

let cached: { slides: HomeSlide[]; at: number } | null = null;

/** Последний ответ, если свежий, — им карусель рисуется сразу, без заглушки. */
export function cachedSlides(now = Date.now()): HomeSlide[] | null {
  return cached !== null && now - cached.at < HOME_FRESH_MS ? cached.slides : null;
}

/** Не ответил сервер — `null`: карусели нет, главная работает без неё. */
export async function loadSlides(api: HomeApi = createHomeApi(), now = Date.now()): Promise<HomeSlide[] | null> {
  const fresh = cachedSlides(now);
  if (fresh !== null) return fresh;
  const response = await api.slides();
  if (!response.ok) return null;
  cached = { slides: response.data, at: now };
  return response.data;
}

export function forgetSlidesForTests(): void {
  cached = null;
}
