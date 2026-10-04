import { create } from "zustand";
import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useBadges } from "./badges";
import { useShell } from "./shell";

/**
 * Главная (docs/35-stage4-plan.md WP42): карусель и виджеты одним ответом
 * (`GET /api/v1/me/home`). Что показать в карусели и в каком порядке, решает
 * сервер, клиент только рисует. Незнакомый вид слайда — сервер новее
 * клиента — отбрасывается по одному, а не роняет всю карусель; битый виджет
 * остаётся без подробностей, а не уносит соседей. Разбирается только то, что
 * главная рисует: слайд ведёт на экран целиком, а не к товару или заданию.
 *
 * Модуль едет с чанком главной — первой загрузке он не нужен.
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

const amountSchema = z.object({ coins: z.number(), shards: z.number() });

const dailyWidgetSchema = z.object({
  canClaim: z.boolean(),
  days: z.array(z.object({ coins: z.number(), shards: z.number(), claimed: z.boolean(), today: z.boolean() })),
  next: amountSchema,
});

const wheelWidgetSchema = z.object({
  free: z.boolean(),
  jackpot: z.nullable(z.number()),
  ad: z.object({ available: z.boolean(), readyAt: z.nullable(z.string()), vip: z.boolean() }),
});

const tasksWidgetSchema = z.object({ dailyDone: z.number(), dailyTotal: z.number(), claimable: z.number() });

export type DailyWidget = z.infer<typeof dailyWidgetSchema>;
export type WheelWidget = z.infer<typeof wheelWidgetSchema>;
export type TasksWidget = z.infer<typeof tasksWidgetSchema>;

/** Подробности виджетов; `null` — источник не ответил или сервер старее клиента. */
export interface HomeWidgets {
  daily: DailyWidget | null;
  wheel: WheelWidget | null;
  tasks: TasksWidget | null;
}

export interface HomeData {
  slides: HomeSlide[];
  widgets: HomeWidgets;
}

/** Слайды и виджеты разбираются по одному: незнакомое не должно стоить соседей. */
const viewSchema = z.object({
  slides: z.array(z.unknown()),
  widgets: z.optional(z.object({ daily: z.optional(z.unknown()), wheel: z.optional(z.unknown()), tasks: z.optional(z.unknown()) })),
});

function parsed<T>(schema: z.ZodMiniType<T>, raw: unknown): T | null {
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}

export interface HomeApi {
  home(): Promise<ApiResult<HomeData>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createHomeApi(request: ApiRequest = apiRequest): HomeApi {
  return {
    async home() {
      const response = await request("/api/v1/me/home", viewSchema, { method: "GET" });
      if (!response.ok) return response;
      const { slides, widgets } = response.data;
      return {
        ok: true,
        data: {
          slides: slides.flatMap((raw) => {
            const slide = parsed(slideSchema, raw);
            return slide === null ? [] : [slide];
          }),
          widgets: {
            daily: parsed(dailyWidgetSchema, widgets?.daily),
            wheel: parsed(wheelWidgetSchema, widgets?.wheel),
            tasks: parsed(tasksWidgetSchema, widgets?.tasks),
          },
        },
      };
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

/** Карусель и подробности виджетов — только с входом: всё собрано по аккаунту. */
export function homeAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}

/**
 * Сколько ответ считается свежим: на главную возвращаются после каждого
 * забега, и спрашивать сервер на каждом возврате незачем — новое в версии и
 * купленный набор подождут минуту. Раньше ответ устаревает, только если с
 * тех пор обновились знаки меню (`badges-api.ts`): их перезагружают забег,
 * забор награды, крутка и возврат в приложение — то, что меняет виджеты.
 */
export const HOME_FRESH_MS = 60_000;

export interface HomeState {
  /** последний ответ; `null` — ещё не приходил */
  data: HomeData | null;
  /** когда за ним пошли — по этому времени и по знакам меню видно, свежий ли он */
  askedAt: number;
  /** знаки меню на момент запроса: обновились после — ответ устарел */
  badgesAt: number;
  /** сервер не ответил, а показать нечего: карусели нет, виджеты без подробностей */
  failed: boolean;
}

export const useHome = create<HomeState>()(() => ({ data: null, askedAt: 0, badgesAt: 0, failed: false }));

export function homeFresh(state: HomeState, now: number, badgesAt: number): boolean {
  return state.data !== null && now - state.askedAt < HOME_FRESH_MS && state.badgesAt === badgesAt;
}

let inflight: Promise<void> | null = null;

/**
 * Освежить главную, если ответ устарел. Прежний ответ остаётся на экране,
 * пока идёт новый: карусель и виджеты не мигают заглушкой на каждом
 * возврате. Два слота главной спрашивают разом — запрос один.
 */
export function refreshHome(api: HomeApi = createHomeApi(), now = Date.now()): Promise<void> {
  const badgesAt = useBadges.getState().loadedAt;
  if (homeFresh(useHome.getState(), now, badgesAt)) return Promise.resolve();
  if (inflight !== null) return inflight;
  inflight = api
    .home()
    .then((response) => {
      if (response.ok) useHome.setState({ data: response.data, askedAt: now, badgesAt, failed: false });
      else if (useHome.getState().data === null) useHome.setState({ failed: true });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function forgetHomeForTests(): void {
  inflight = null;
  useHome.setState({ data: null, askedAt: 0, badgesAt: 0, failed: false });
}
