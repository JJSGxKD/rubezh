import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import "../src/i18n/tasks";
import { arrangeWidgets, passFace } from "../src/screens/home-widget-rules";
import { PassBoard } from "../src/screens/meta/pass";
import {
  cellState,
  claimableRewards,
  daysLeft,
  focusTier,
  gainText,
  lockedVipCount,
  monthGenitive,
  parsePassStart,
  pointsToNext,
} from "../src/screens/meta/pass-rules";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { ANALYTICS_EVENTS } from "../src/state/analytics";
import { useNavigation } from "../src/state/navigation";
import {
  PASS_ALREADY_CLAIMED,
  PASS_TIER_NOT_REACHED,
  PASS_VIP_REQUIRED,
  claimAll,
  createPassApi,
  passClaimFailureKey,
  type PassApi,
  type PassSnapshot,
} from "../src/state/pass-api";

// Экран батл-пасса (docs/35-stage4-plan.md Р46, tasks/T-0314): две ленты по
// 30 ступеням, очки до следующей, забор по одной и всё сразу, замок VIP,
// виджет главной. Ступень и забор считает сервер (`GET /pass`,
// `POST /pass/claim`); клиент только показывает, что можно забрать, и просит.

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
/** Конец ноября по Москве: 30 ноября 21:00 UTC — через 11,5 суток от NOW. */
const ENDS_AT = "2026-11-30T21:00:00.000Z";

/** Месяц с лентой по умолчанию: монеты у бесплатной, самоцветы у VIP. */
function snapshot(patch: Partial<PassSnapshot> = {}, claimed: { free?: number[]; vip?: number[] } = {}): PassSnapshot {
  return {
    monthKey: "2026-11",
    endsAt: ENDS_AT,
    points: 750,
    tier: 7,
    pointsPerTier: 100,
    vip: false,
    tiers: Array.from({ length: 30 }, (_, index) => ({
      tier: index + 1,
      free: { coins: 100 + index * 10 },
      vip: { gems: 10 + index },
      claimed: { free: (claimed.free ?? []).includes(index + 1), vip: (claimed.vip ?? []).includes(index + 1) },
    })),
    ...patch,
  };
}

/** Середина месяца: седьмая ступень, бесплатная забрана по пятую, VIP нет. */
const MID = snapshot({}, { free: [1, 2, 3, 4, 5] });

describe("очки до следующей ступени", () => {
  it("250 очков при 100 на ступень — вторая ступень и ещё 50 очков до третьей", () => {
    expect(pointsToNext({ points: 250, pointsPerTier: 100, tier: 2 })).toEqual({ tier: 2, atMax: false, into: 50, step: 100, remaining: 50 });
  });

  it("новичок на нулевой — до первой ступени целый шаг", () => {
    expect(pointsToNext({ points: 0, pointsPerTier: 100, tier: 0 })).toEqual({ tier: 0, atMax: false, into: 0, step: 100, remaining: 100 });
  });

  it("тридцатая ступень — очков больше не нужно, полоса полная", () => {
    expect(pointsToNext({ points: 3_400, pointsPerTier: 100, tier: 30 })).toEqual({ tier: 30, atMax: true, into: 100, step: 100, remaining: 0 });
  });
});

describe("что можно забрать", () => {
  it("пройденные и не забранные; будущие и забранные — нет; без VIP — только бесплатная", () => {
    expect(claimableRewards(MID)).toEqual([
      { tier: 6, lane: "free" },
      { tier: 7, lane: "free" },
    ]);
  });

  it("с VIP открывается и вторая лента, включая пройденное до покупки", () => {
    const targets = claimableRewards({ ...MID, vip: true });
    expect(targets.filter((target) => target.lane === "vip")).toHaveLength(7);
    expect(targets.slice(0, 3)).toEqual([
      { tier: 1, lane: "vip" },
      { tier: 2, lane: "vip" },
      { tier: 3, lane: "vip" },
    ]);
    expect(targets.at(-1)).toEqual({ tier: 7, lane: "vip" });
  });

  it("порядок: по ступеням, на одной ступени бесплатная раньше VIP", () => {
    const view = snapshot({ vip: true, points: 200, tier: 2 });
    expect(claimableRewards(view)).toEqual([
      { tier: 1, lane: "free" },
      { tier: 1, lane: "vip" },
      { tier: 2, lane: "free" },
      { tier: 2, lane: "vip" },
    ]);
  });

  it("одну ленту — когда просят «Забрать всё» на ней", () => {
    const view = { ...MID, vip: true };
    expect(claimableRewards(view, "free")).toHaveLength(2);
    expect(claimableRewards(view, "vip")).toHaveLength(7);
  });

  it("всё забрано — пусто; новичок на нулевой — пусто", () => {
    expect(claimableRewards(snapshot({ vip: true }, { free: [1, 2, 3, 4, 5, 6, 7], vip: [1, 2, 3, 4, 5, 6, 7] }))).toEqual([]);
    expect(claimableRewards(snapshot({ points: 0, tier: 0 }))).toEqual([]);
  });
});

describe("состояние ячейки ленты", () => {
  it("забрана, готова, ждёт VIP, цель, впереди", () => {
    expect(cellState(MID, 3, "free")).toBe("claimed");
    expect(cellState(MID, 6, "free")).toBe("ready");
    expect(cellState(MID, 6, "vip")).toBe("locked");
    expect(cellState({ ...MID, vip: true }, 6, "vip")).toBe("ready");
    expect(cellState(MID, 8, "free")).toBe("next");
    expect(cellState(MID, 9, "free")).toBe("future");
  });

  it("забранное остаётся забранным, даже когда VIP кончился", () => {
    expect(cellState(snapshot({ vip: false }, { vip: [1] }), 1, "vip")).toBe("claimed");
  });
});

describe("замок VIP", () => {
  it("без VIP — сколько наград лежит под замком, считая пройденные", () => {
    expect(lockedVipCount(MID)).toBe(30);
    expect(lockedVipCount(snapshot({}, { vip: [1, 2] }))).toBe(28);
  });

  it("плашка замка есть без VIP и пропадает с ним", () => {
    const locked = renderToStaticMarkup(createElement(PassBoard, { view: MID, now: NOW, busy: null, notice: null, onClaim: () => undefined, onClaimAll: () => undefined, onVip: () => undefined }));
    expect(locked).toContain("С VIP — ещё 30 наград, включая пройденные");
    const open = renderToStaticMarkup(createElement(PassBoard, { view: { ...MID, vip: true }, now: NOW, busy: null, notice: null, onClaim: () => undefined, onClaimAll: () => undefined, onVip: () => undefined }));
    expect(open).not.toContain("включая пройденные");
  });
});

describe("шапка и срок месяца", () => {
  it("срок — целые сутки вверх, месяц — в родительном падеже", () => {
    expect(daysLeft(ENDS_AT, NOW)).toBe(12);
    expect(daysLeft(ENDS_AT, Date.parse(ENDS_AT) - 1_000)).toBe(1);
    expect(daysLeft(ENDS_AT, Date.parse(ENDS_AT) + DAY)).toBe(0);
    expect(monthGenitive("2026-11")).toBe("ноября");
    expect(monthGenitive("2026-01")).toBe("января");
    expect(monthGenitive("мусор")).toBeNull();
  });

  it("заголовок и очки до следующей — словами спецификации", () => {
    const html = renderToStaticMarkup(createElement(PassBoard, { view: snapshot({ points: 250, tier: 2 }), now: NOW, busy: null, notice: null, onClaim: () => undefined, onClaimAll: () => undefined, onVip: () => undefined }));
    expect(html).toContain("Пасс ноября · ещё 12 дн.");
    expect(html).toContain("ещё 50 очков");
    expect(html).toContain("Очки пасса — за задания дня и недели");
  });

  it("ленты листаются к текущей ступени, на нулевой — к первой", () => {
    expect(focusTier(MID)).toBe(7);
    expect(focusTier(snapshot({ points: 0, tier: 0 }))).toBe(1);
    expect(focusTier(snapshot({ points: 3_100, tier: 30 }))).toBe(30);
  });
});

describe("лента на экране", () => {
  const render = (view: PassSnapshot, notice: string | null = null, busy: string | null = null) =>
    renderToStaticMarkup(createElement(PassBoard, { view, now: NOW, busy, notice, onClaim: () => undefined, onClaimAll: () => undefined, onVip: () => undefined }));

  it("тридцать ступеней в каждой из двух лент", () => {
    const html = render(MID);
    expect(html.match(/data-pass-cell="\d+:free"/g)).toHaveLength(30);
    expect(html.match(/data-pass-cell="\d+:vip"/g)).toHaveLength(30);
  });

  it("«Забрать» стоит на пройденной незабранной, у забранной — отметка, у будущей — ничего", () => {
    const html = render(MID);
    expect(html).toContain('data-pass-take="6:free"');
    expect(html).toContain('data-pass-take="7:free"');
    expect(html).not.toContain('data-pass-take="5:free"');
    expect(html).not.toContain('data-pass-take="8:free"');
    expect(html).toContain('data-pass-cell="5:free" data-state="claimed"');
  });

  it("«Забрать всё» — на ленте, где доступных две и больше", () => {
    expect(render(MID)).toContain('data-pass-all="free"');
    expect(render({ ...MID, vip: true })).toContain('data-pass-all="vip"');
    expect(render(snapshot({}, { free: [1, 2, 3, 4, 5, 6] }))).not.toContain('data-pass-all="free"');
  });

  it("всё забрано — «Забрать» нигде нет", () => {
    const html = render(snapshot({ vip: true }, { free: [1, 2, 3, 4, 5, 6, 7], vip: [1, 2, 3, 4, 5, 6, 7] }));
    expect(html).not.toContain("data-pass-take");
    expect(html).not.toContain("data-pass-all");
  });

  it("пока идёт забор, кнопки не нажимаются", () => {
    expect(render(MID, null, "6:free")).toContain("disabled");
  });
});

describe("разбор ответа GET /pass", () => {
  interface Sent {
    method: string;
    path: string;
    body: unknown;
  }

  function server(sent: Sent[], answer: unknown): ApiRequest {
    return async <T,>(path: string, schema: object, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> => {
      sent.push({ method: init?.method ?? "GET", path, body: init?.body });
      const { z } = await import("zod/mini");
      const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
      return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
    };
  }

  it("состояние месяца читается: очки, ступень, VIP и две награды на ступени", async () => {
    const sent: Sent[] = [];
    const wire = {
      ...MID,
      tiers: [{ tier: 1, free: { coins: 100, shards: { common: 5 }, boost: { id: "fury", count: 1 } }, vip: { gems: 10 }, claimed: { free: true, vip: false } }],
    };
    const result = await createPassApi(server(sent, wire)).load();
    expect(result.ok && result.data).toMatchObject({ monthKey: "2026-11", points: 750, tier: 7, vip: false, pointsPerTier: 100 });
    expect(result.ok && result.data.tiers[0]).toEqual(wire.tiers[0]);
    expect(sent).toEqual([{ method: "GET", path: "/api/v1/pass", body: undefined }]);
  });

  it("ответ не по схеме — отказ, а не пустая лента", async () => {
    expect((await createPassApi(server([], { ...MID, tiers: "нет" })).load()).ok).toBe(false);
    expect((await createPassApi(server([], { ...MID, tier: "семь" })).load()).ok).toBe(false);
  });

  it("забор — POST со ступенью и лентой; ответ называет, что легло на счёт", async () => {
    const sent: Sent[] = [];
    const result = await createPassApi(server(sent, { tier: 6, lane: "free", credited: { coins: 150 } })).claim(6, "free");
    expect(result.ok && result.data).toEqual({ tier: 6, lane: "free", credited: { coins: 150 } });
    expect(sent).toEqual([{ method: "POST", path: "/api/v1/pass/claim", body: { tier: 6, lane: "free" } }]);
  });
});

describe("отказ в заборе", () => {
  it("каждый код говорит своё: ещё не достигнута, уже забрана, нужен VIP; прочее — общий отказ", () => {
    expect(passClaimFailureKey(PASS_TIER_NOT_REACHED)).toBe("pass.stale");
    expect(passClaimFailureKey(PASS_ALREADY_CLAIMED)).toBe("pass.alreadyClaimed");
    expect(passClaimFailureKey(PASS_VIP_REQUIRED)).toBe("pass.vipRequired");
    expect(passClaimFailureKey(undefined)).toBe("pass.claimFailed");
    expect(passClaimFailureKey("rate_limited")).toBe("pass.claimFailed");
  });
});

describe("«Забрать всё»", () => {
  type Answer = ApiResult<{ tier: number; lane: "free" | "vip"; credited: { coins?: number; gems?: number } }>;

  /** Сервер по очереди отвечает на каждый забор; `at` — ответ по ступени и ленте. */
  function fake(answer: (tier: number, lane: "free" | "vip") => Answer): { api: PassApi; asked: string[] } {
    const asked: string[] = [];
    const api: PassApi = {
      load: async () => ({ ok: true, data: MID }),
      claim: async (tier, lane) => {
        asked.push(`${String(tier)}:${lane}`);
        return answer(tier, lane);
      },
    };
    return { api, asked };
  }

  const targets = [
    { tier: 6, lane: "free" as const },
    { tier: 7, lane: "free" as const },
    { tier: 7, lane: "vip" as const },
  ];

  it("забирает по очереди, суммирует начисленное по всем ответам", async () => {
    const { api, asked } = fake((tier, lane) => ({ ok: true, data: { tier, lane, credited: lane === "free" ? { coins: 100 * tier } : { gems: 5 } } }));
    const result = await claimAll(api, targets);
    expect(asked).toEqual(["6:free", "7:free", "7:vip"]);
    expect(result.claimed).toEqual(targets);
    expect(result.gain).toEqual({ coins: 1_300, gems: 5, shards: 0, boosts: 0 });
    expect(result.failure).toBeNull();
  });

  it("«уже забрана» — не помеха: ступень пропускается, остальные забираются", async () => {
    const { api, asked } = fake((tier, lane) => (tier === 6 ? { ok: false, failure: "rejected", code: PASS_ALREADY_CLAIMED } : { ok: true, data: { tier, lane, credited: { coins: 10 } } }));
    const result = await claimAll(api, targets);
    expect(asked).toHaveLength(3);
    expect(result.claimed).toEqual([targets[1], targets[2]]);
    expect(result.failure).toBeNull();
    expect(result.stale).toBe(true);
  });

  it("«ступень не достигнута» и обрыв сети останавливают забор: остальные не запрашиваются", async () => {
    const stop = fake((tier, lane) => (tier === 7 ? { ok: false, failure: "rejected", code: PASS_TIER_NOT_REACHED } : { ok: true, data: { tier, lane, credited: { coins: 10 } } }));
    const first = await claimAll(stop.api, targets);
    expect(stop.asked).toEqual(["6:free", "7:free"]);
    expect(first.claimed).toEqual([targets[0]]);
    expect(first.failure).toEqual({ failure: "rejected", code: PASS_TIER_NOT_REACHED });

    const offline = fake(() => ({ ok: false, failure: "offline" }));
    const second = await claimAll(offline.api, targets);
    expect(offline.asked).toEqual(["6:free"]);
    expect(second.claimed).toEqual([]);
    expect(second.failure).toEqual({ failure: "offline" });
  });

  it("«нужен VIP» пропускает остаток VIP-ленты, но бесплатная забирается дальше", async () => {
    const mixed = [
      { tier: 1, lane: "vip" as const },
      { tier: 2, lane: "vip" as const },
      { tier: 2, lane: "free" as const },
    ];
    const { api, asked } = fake((tier, lane) => (lane === "vip" ? { ok: false, failure: "rejected", code: PASS_VIP_REQUIRED } : { ok: true, data: { tier, lane, credited: { coins: 10 } } }));
    const result = await claimAll(api, mixed);
    expect(asked).toEqual(["1:vip", "2:free"]);
    expect(result.claimed).toEqual([mixed[2]]);
    expect(result.stale).toBe(true);
  });

  it("подарок-буст считается: на счёт идёт число бустов, а не их названия", () => {
    expect(gainText({ coins: 0, gems: 0, shards: 0, boosts: 2 })).toContain("2");
    expect(gainText({ coins: 300, gems: 0, shards: 4, boosts: 0 })).toBe("300 монет и 4 осколка");
  });
});

describe("виджет главной", () => {
  it("есть что забрать — «готов» с числом наград и ступенью", () => {
    expect(passFace(MID)).toMatchObject({ state: "ready", tier: 7, claimable: 2 });
  });

  it("забрано всё — просто ход пасса: ступень и очки до следующей", () => {
    const view = snapshot({ points: 750, tier: 7 }, { free: [1, 2, 3, 4, 5, 6, 7] });
    expect(passFace(view)).toMatchObject({ state: "progress", tier: 7, remaining: 50 });
  });

  it("нет ответа сервера — виджета нет", () => {
    expect(passFace(null)).toBeNull();
  });

  it("сетка: без пасса прежние пять виджетов, с пассом он плиткой, а с наградами — первым во всю ширину", () => {
    const base = { daily: false, wheel: false, tasks: false };
    expect(arrangeWidgets(base).map((slot) => slot.id)).not.toContain("pass");
    expect(arrangeWidgets({ ...base, pass: false }).map((slot) => slot.id)).toContain("pass");
    const ready = arrangeWidgets({ ...base, wheel: true, pass: true });
    expect(ready.map((slot) => slot.id).slice(0, 2)).toEqual(["wheel", "pass"]);
    expect(ready.slice(0, 2).every((slot) => slot.size === "hero")).toBe(true);
    // Нечётное число плиток — последняя строкой, дыр в сетке нет.
    for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
      for (const pass of [false, true]) {
        const slots = arrangeWidgets({ daily: (mask & 1) > 0, wheel: (mask & 2) > 0, tasks: (mask & 4) > 0, pass });
        expect(slots.filter((slot) => slot.size === "tile").length % 2, `${String(mask)} ${String(pass)}`).toBe(0);
      }
    }
  });
});

describe("адрес экрана", () => {
  beforeEach(() => {
    useNavigation.setState({ stack: ["lobby"] });
  });

  it("стартовый параметр: кнопка уведомления бота о закрытии и пара pass; чужие — нет", () => {
    expect(parsePassStart("n-pass_closed")).toBe(true);
    expect(parsePassStart("pass-open")).toBe(true);
    expect(parsePassStart("n-daily_reward_ready")).toBe(false);
    expect(parsePassStart("run-abcdefgh12")).toBe(false);
    expect(parsePassStart(null)).toBe(false);
    expect(parsePassStart("")).toBe(false);
  });

  it("открыть пасс — вкладка «Задания» с пометкой, откуда пришёл игрок; пометку экран забирает один раз", async () => {
    const { openPass, takePassOrigin } = await import("../src/state/navigation");
    openPass("widget");
    expect(useNavigation.getState().stack).toEqual(["tasks"]);
    expect(takePassOrigin()).toBe("widget");
    expect(takePassOrigin()).toBeNull();
  });
});

describe("события пасса", () => {
  it("клиент знает оба имени из словаря", () => {
    expect(ANALYTICS_EVENTS).toContain("pass_opened");
    expect(ANALYTICS_EVENTS).toContain("pass_reward_claimed");
  });
});
