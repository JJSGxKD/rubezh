import { beforeEach, describe, expect, it } from "vitest";
import { t } from "../src/i18n";
import "../src/i18n/restrictions";
import type { ApiResult } from "../src/state/api-request";
import {
  activeOf,
  loadRestrictions,
  RESTRICTIONS_FRESH_MS,
  restrictionRefusal,
  useRestrictions,
  type PlayerRestriction,
  type RestrictionsApi,
} from "../src/state/restrictions";

// Ограничения у игрока (docs/35-stage4-plan.md WP44, часть 4): список один на
// оболочку и перечитывается по отказу сервера; плашка показывает срок и
// причину словами сервера; блокировка целиком закрывает всё; ограничение,
// снятое, пока шёл запрос, — повод повторить, а не плашка.

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const DAY = 86_400_000;

function row(patch: Partial<PlayerRestriction> = {}): PlayerRestriction {
  return { kind: "promo_codes", title: "Промокоды", endsAt: new Date(NOW + DAY).toISOString(), until: "до 5 октября, 15:00 МСК", reason: "Промокоды использовались не по правилам", ...patch };
}

function fakeApi(...answers: ApiResult<{ restrictions: PlayerRestriction[] }>[]): RestrictionsApi & { calls: number } {
  const api = {
    calls: 0,
    mine: async () => {
      const answer = answers[Math.min(api.calls, answers.length - 1)];
      api.calls += 1;
      if (answer === undefined) throw new Error("ответов нет");
      return answer;
    },
  };
  return api;
}

const ok = (...rows: PlayerRestriction[]): ApiResult<{ restrictions: PlayerRestriction[] }> => ({ ok: true, data: { restrictions: rows } });

beforeEach(() => {
  useRestrictions.setState({ list: [], loadedAt: null });
});

describe("список ограничений", () => {
  it("свежий не перечитывается, устаревший и после отказа — да; одновременные просьбы — одним запросом", async () => {
    const api = fakeApi(ok(row()), ok());
    await Promise.all([loadRestrictions(false, api, NOW), loadRestrictions(false, api, NOW)]);
    expect(api.calls).toBe(1);
    expect(useRestrictions.getState().list).toHaveLength(1);

    await loadRestrictions(false, api, NOW + RESTRICTIONS_FRESH_MS - 1);
    expect(api.calls).toBe(1);
    await loadRestrictions(true, api, NOW + 1);
    expect(api.calls).toBe(2);
    expect(useRestrictions.getState().list).toEqual([]);
  });

  it("сервер не ответил — плашка, которую игрок уже видел, остаётся", async () => {
    await loadRestrictions(false, fakeApi(ok(row())), NOW);
    await loadRestrictions(true, fakeApi({ ok: false, failure: "offline" }), NOW);
    expect(useRestrictions.getState().list).toHaveLength(1);
  });

  it("действующие — нужного вида и блокировка целиком; вышедший срок не держит", () => {
    const list = [row(), row({ kind: "ad_rewards", title: "Награды за рекламу" }), row({ kind: "friend_gifts", endsAt: new Date(NOW - 1).toISOString() }), row({ kind: "leaderboard", endsAt: null, until: "бессрочно" })];
    expect(activeOf(list, ["promo_codes"], NOW).map((item) => item.kind)).toEqual(["promo_codes"]);
    expect(activeOf(list, ["friend_gifts", "referral_rewards"], NOW)).toEqual([]);
    expect(activeOf(list, ["leaderboard"], NOW).map((item) => item.until)).toEqual(["бессрочно"]);
    expect(activeOf([row({ kind: "all", title: "Всё — блокировка" })], ["promo_codes"], NOW).map((item) => item.kind)).toEqual(["all"]);
  });
});

describe("отказ сервера", () => {
  const refused: ApiResult<unknown> = { ok: false, failure: "disabled", code: "account_restricted" };

  it("закрыто ограничением — список перечитан, плашка встанет на место ошибки", async () => {
    const api = fakeApi(ok(row()));
    expect(await restrictionRefusal(refused, ["promo_codes"], api)).toBe("restricted");
    expect(api.calls).toBe(1);
    expect(useRestrictions.getState().list).toHaveLength(1);
  });

  it("пока шёл запрос, ограничение сняли — «попробуйте ещё раз»; чужой отказ — не наш", async () => {
    expect(await restrictionRefusal(refused, ["promo_codes"], fakeApi(ok()))).toBe("lifted");
    const api = fakeApi(ok(row()));
    expect(await restrictionRefusal({ ok: false, failure: "rejected", code: "promo_code_expired" }, ["promo_codes"], api)).toBeNull();
    expect(await restrictionRefusal({ ok: true, data: null }, ["promo_codes"], api)).toBeNull();
    expect(api.calls).toBe(0);
  });
});

describe("тексты плашки", () => {
  it("срок и причина — словами сервера внутри рамки клиента", () => {
    expect(t("restricted.until", { until: "до 5 октября, 15:00 МСК" })).toBe("Закрыто до 5 октября, 15:00 МСК");
    expect(t("restricted.until", { until: "бессрочно" })).toBe("Закрыто бессрочно");
    expect(t("restricted.reason", { reason: "Подозрительные забеги в рейтинге" })).toBe("Причина: Подозрительные забеги в рейтинге");
    expect(t("restricted.write")).toBe("Написать нам");
  });
});
