import { create } from "zustand";
import { z } from "zod/mini";
import { apiRequest, type ApiFailure, type ApiRequest, type ApiResult } from "./api-request";
import { useBadges } from "./badges";
import { useShell } from "./shell";

/**
 * Батл-пасс с сервера (docs/35-stage4-plan.md Р46, tasks/T-0311, T-0314):
 * очки месяца, ступень, VIP и две ленты по 30 наград (`GET /api/v1/pass`),
 * забор одной награды (`POST /api/v1/pass/claim`). Ступень по очкам и право на
 * забор решает сервер, клиент только показывает, что можно забрать, и просит.
 *
 * Награда — монеты, самоцветы, осколки по редкостям и подарок-буст. Ключи
 * редкостей и вид буста — строками: сервер новее клиента может завести то, чего
 * клиент не знает, и ячейка нарисуется без значка, а не уронит экран.
 *
 * Модуль едет с чанком главной и экрана заданий — первой загрузке он не нужен.
 */

const rewardSchema = z.object({
  coins: z.optional(z.number()),
  gems: z.optional(z.number()),
  shards: z.optional(z.record(z.string(), z.number())),
  boost: z.optional(z.object({ id: z.string(), count: z.number() })),
});

const laneSchema = z.enum(["free", "vip"]);

const snapshotSchema = z.object({
  /** месяц пасса `ГГГГ-ММ` по Москве */
  monthKey: z.string(),
  /** конец месяца, UTC */
  endsAt: z.string(),
  points: z.number(),
  /** достигнутая ступень, 0…30 */
  tier: z.number(),
  pointsPerTier: z.number(),
  /** VIP активен прямо сейчас */
  vip: z.boolean(),
  tiers: z.array(
    z.object({
      tier: z.number(),
      free: rewardSchema,
      vip: rewardSchema,
      claimed: z.object({ free: z.boolean(), vip: z.boolean() }),
    }),
  ),
});

/** Что легло на счёт при заборе: по ресурсам, после суточного потолка кошелька. */
const claimSchema = z.object({ tier: z.number(), lane: laneSchema, credited: rewardSchema });

export type PassLane = z.infer<typeof laneSchema>;
export type PassReward = z.infer<typeof rewardSchema>;
export type PassSnapshot = z.infer<typeof snapshotSchema>;
export type PassTier = PassSnapshot["tiers"][number];
export type PassClaim = z.infer<typeof claimSchema>;

/** Ступень и лента одной награды — то, что называют серверу. */
export interface PassTarget {
  tier: number;
  lane: PassLane;
}

/** Ступеней в ленте месяца. */
export const PASS_TIERS = 30;

/** Коды отказа сервера (`battle-pass/pass-errors.ts`), все — 409. */
export const PASS_TIER_NOT_REACHED = "pass_tier_not_reached";
export const PASS_ALREADY_CLAIMED = "pass_already_claimed";
export const PASS_VIP_REQUIRED = "pass_vip_required";

/** Текст отказа в заборе по коду сервера — ключом словаря. Незнакомый код — общий отказ. */
export function passClaimFailureKey(code: string | undefined): string {
  switch (code) {
    case PASS_TIER_NOT_REACHED:
      return "pass.stale";
    case PASS_ALREADY_CLAIMED:
      return "pass.alreadyClaimed";
    case PASS_VIP_REQUIRED:
      return "pass.vipRequired";
    default:
      return "pass.claimFailed";
  }
}

export interface PassApi {
  load(): Promise<ApiResult<PassSnapshot>>;
  claim(tier: number, lane: PassLane): Promise<ApiResult<PassClaim>>;
}

const PATH = "/api/v1/pass";

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createPassApi(request: ApiRequest = apiRequest): PassApi {
  return {
    load: () => request(PATH, snapshotSchema, { method: "GET" }),
    claim: (tier, lane) => request(`${PATH}/claim`, claimSchema, { method: "POST", body: { tier, lane } }),
  };
}

/** Пасс — только с входом: очки и ступени собраны по аккаунту. */
export function passAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}

/** Сколько пришло на счёт за один «Забрать всё»: один отклик счёта на всё (#460). */
export interface PassGain {
  coins: number;
  gems: number;
  shards: number;
  boosts: number;
}

export interface ClaimAllResult {
  /** что забрано — в порядке запроса */
  claimed: PassTarget[];
  gain: PassGain;
  /** забор остановлен отказом; `null` — прошёл до конца */
  failure: { failure: ApiFailure; code?: string } | null;
  /** экран отстал от сервера (уже забрано, VIP кончился): пасс стоит перечитать */
  stale: boolean;
}

/** Сколько легло на счёт в одном ответе; осколки всех редкостей — одним числом, как у заданий. */
export function gainOf(credited: PassReward): PassGain {
  return {
    coins: credited.coins ?? 0,
    gems: credited.gems ?? 0,
    shards: Object.values(credited.shards ?? {}).reduce((sum, amount) => sum + amount, 0),
    boosts: credited.boost?.count ?? 0,
  };
}

/**
 * Забрать всё доступное по очереди, по одной награде за запрос: сервер выдаёт
 * каждую отдельным журналом и отдельным ключом кошелька.
 *
 * - «уже забрана» — не помеха: ступень пропускается, пасс помечается устаревшим;
 * - «нужен VIP» — пропускается остаток VIP-ленты, бесплатная идёт дальше;
 * - «ступень не достигнута» и любой другой отказ (сеть, сервер) — остановка:
 *   дальше будет то же самое, а повтор по кнопке безопасен — сервер идемпотентен.
 */
export async function claimAll(api: PassApi, targets: readonly PassTarget[]): Promise<ClaimAllResult> {
  const claimed: PassTarget[] = [];
  const gain: PassGain = { coins: 0, gems: 0, shards: 0, boosts: 0 };
  let stale = false;
  let vipClosed = false;
  for (const target of targets) {
    if (target.lane === "vip" && vipClosed) continue;
    const response = await api.claim(target.tier, target.lane);
    if (response.ok) {
      claimed.push(target);
      const credited = gainOf(response.data.credited);
      gain.coins += credited.coins;
      gain.gems += credited.gems;
      gain.shards += credited.shards;
      gain.boosts += credited.boosts;
      continue;
    }
    if (response.code === PASS_ALREADY_CLAIMED) {
      stale = true;
      continue;
    }
    if (response.code === PASS_VIP_REQUIRED) {
      stale = true;
      vipClosed = true;
      continue;
    }
    return { claimed, gain, failure: { failure: response.failure, ...(response.code === undefined ? {} : { code: response.code }) }, stale: stale || response.code === PASS_TIER_NOT_REACHED };
  }
  return { claimed, gain, failure: null, stale };
}

/**
 * Пасс в сторе: его читают вкладка «Пасс» и виджет главной, и спрашивать сервер
 * дважды за открытие незачем. Прежний ответ остаётся на экране, пока идёт новый.
 */
export interface PassState {
  view: PassSnapshot | null;
  /** когда за ним пошли; по времени и по знакам меню видно, свежий ли он */
  askedAt: number;
  badgesAt: number;
  /** сервер не ответил, а показать нечего */
  failure: ApiFailure | null;
  loading: boolean;
}

export const usePass = create<PassState>()(() => ({ view: null, askedAt: 0, badgesAt: 0, failure: null, loading: false }));

/** Как долго ответ свежий: возвращаются на главную после каждого забега, и спрашивать каждый раз незачем. */
export const PASS_FRESH_MS = 60_000;

let inflight: Promise<void> | null = null;

/**
 * Загрузить пасс. `force` — после забора и по «Повторить»: свежесть не смотрим.
 * Два слота (главная и вкладка) спрашивают разом — запрос один.
 */
export function loadPass(options: { force?: boolean; api?: PassApi; now?: number } = {}): Promise<void> {
  const now = options.now ?? Date.now();
  const badgesAt = useBadges.getState().loadedAt;
  const state = usePass.getState();
  if (options.force !== true && state.view !== null && now - state.askedAt < PASS_FRESH_MS && state.badgesAt === badgesAt) return Promise.resolve();
  if (inflight !== null) return inflight;
  usePass.setState({ loading: true });
  inflight = (options.api ?? createPassApi())
    .load()
    .then((response) => {
      if (response.ok) usePass.setState({ view: response.data, askedAt: now, badgesAt, failure: null, loading: false });
      else usePass.setState({ failure: response.failure, loading: false });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function forgetPassForTests(): void {
  inflight = null;
  usePass.setState({ view: null, askedAt: 0, badgesAt: 0, failure: null, loading: false });
}
