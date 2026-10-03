import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  draftProblem,
  emptyDraft,
  endsAtOf,
  fetchRestrictionCatalog,
  fetchRestrictions,
  imposeBody,
  imposeRestriction,
  leftText,
  liftRestriction,
  outcomeText,
  previewRestriction,
  submitLabel,
  type Restriction,
  type RestrictDraft,
} from "../src/api/restrictions";
import { formatDateTime, localInput } from "../src/format";
import { fakeFetch, json } from "./helpers";

/**
 * Ограничения игрока в панели (docs/35-stage4-plan.md WP44): черновик не
 * уходит на сервер, пока в нём нечего накладывать; срок кнопкой считается от
 * нажатия; блокировку молча не наложить; кнопка и история говорят словами,
 * что случится и чем кончилось.
 */

const NOW = new Date("2026-10-03T12:00:00.000Z");
const DAY = 86_400_000;
const ACCOUNT = "3c8f3a52-2d4e-4c55-9d0e-6f3b2a1c0d9e";

const draft = (patch: Partial<RestrictDraft> = {}): RestrictDraft => ({ ...emptyDraft(), kinds: ["promo_codes"], reason: "promo_abuse", ...patch });

function row(patch: Partial<Restriction> = {}): Restriction {
  return {
    restrictionId: "r1",
    kind: "promo_codes",
    title: "Промокоды",
    state: "active",
    startsAt: NOW.toISOString(),
    endsAt: new Date(NOW.getTime() + 3 * DAY).toISOString(),
    reason: "promo_abuse",
    reasonTitle: "Злоупотребление промокодами",
    comment: null,
    notify: true,
    imposedBy: { accountId: "m1", name: "Ира" },
    liftedAt: null,
    liftedBy: null,
    liftComment: null,
    ...patch,
  };
}

describe("черновик ограничения", () => {
  it("срок кнопкой — от «сейчас», бессрочно — null, до даты — из поля; пустая и битая дата — не срок", () => {
    expect(endsAtOf({ term: "3d", until: "" }, NOW)).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
    expect(endsAtOf({ term: "30d", until: "" }, NOW)).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());
    expect(endsAtOf({ term: "forever", until: "" }, NOW)).toBeNull();
    const until = new Date(NOW.getTime() + 10 * DAY);
    expect(endsAtOf({ term: "date", until: localInput(until) }, NOW)).toBe(new Date(localInput(until)).toISOString());
    expect(endsAtOf({ term: "date", until: "" }, NOW)).toBeUndefined();
    expect(endsAtOf({ term: "date", until: "завтра" }, NOW)).toBeUndefined();
  });

  it("не готов — словами: что закрыть, дата, причина, длина комментария", () => {
    expect(draftProblem(draft({ kinds: [] }), NOW)).toMatch(/что закрыть/);
    expect(draftProblem(draft({ term: "date" }), NOW)).toMatch(/дату/);
    expect(draftProblem(draft({ reason: "" }), NOW)).toMatch(/причину/);
    expect(draftProblem(draft({ comment: "x".repeat(501) }), NOW)).toMatch(/500/);
    expect(draftProblem(draft(), NOW)).toBeNull();
    expect(imposeBody(draft({ reason: "" }), NOW)).toBeNull();
  });

  it("тело наложения: пустой комментарий — null; блокировка — всегда с сообщением игроку", () => {
    expect(imposeBody(draft({ comment: "  ", notify: false }), NOW)).toEqual({ kinds: ["promo_codes"], endsAt: new Date(NOW.getTime() + 3 * DAY).toISOString(), reason: "promo_abuse", comment: null, notify: false });
    expect(imposeBody(draft({ kinds: ["all"], term: "forever", comment: " ферма ", notify: false }), NOW)).toEqual({ kinds: ["all"], endsAt: null, reason: "promo_abuse", comment: "ферма", notify: true });
  });

  it("кнопка говорит, что случится", () => {
    expect(submitLabel(draft(), NOW)).toBe("Ограничить на 3 дня");
    expect(submitLabel(draft({ kinds: ["all"], term: "forever" }), NOW)).toBe("Заблокировать бессрочно");
    const until = localInput(new Date(NOW.getTime() + 10 * DAY));
    expect(submitLabel(draft({ term: "date", until }), NOW)).toBe(`Ограничить до ${formatDateTime(new Date(until).toISOString())}`);
    expect(submitLabel(draft({ term: "date" }), NOW)).toBe("Ограничить");
  });
});

describe("ограничение в карточке", () => {
  it("сколько осталось — двумя крупными единицами", () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(leftText(null, NOW)).toBe("бессрочно");
    expect(leftText(at(2 * DAY + 3 * 3_600_000), NOW)).toBe("ещё 2 дня 3 часа");
    expect(leftText(at(DAY), NOW)).toBe("ещё 1 день");
    expect(leftText(at(5 * 3_600_000 + 60_000), NOW)).toBe("ещё 5 часов 1 минута");
    expect(leftText(at(45 * 60_000), NOW)).toBe("ещё 45 минут");
    expect(leftText(at(-1), NOW)).toBe("срок вышел");
  });

  it("чем кончилось — кто и почему снял, вышел срок или заменили новым", () => {
    expect(outcomeText(row({ state: "lifted", liftedAt: NOW.toISOString(), liftedBy: { accountId: "m2", name: "Вова" }, liftComment: "ошиблись" }))).toBe(`снял Вова ${formatDateTime(NOW.toISOString())}: «ошиблись»`);
    expect(outcomeText(row({ state: "expired" }))).toMatch(/^срок вышел /);
    expect(outcomeText(row({ state: "replaced", liftedAt: NOW.toISOString() }))).toMatch(/^заменено новым /);
    expect(outcomeText(row({ state: "future" }))).toBe("future");
  });
});

describe("ограничения по API", () => {
  it("каталог, история, предпросмотр, наложение и снятие — своими адресами и телами", async () => {
    const catalog = { kinds: [{ kind: "promo_codes", title: "Промокоды", effect: "Промокоды не погашаются.", permission: "players.restrict", silentAllowed: true }], reasons: [{ reason: "promo_abuse", title: "Злоупотребление промокодами", player: "Промокоды использовались не по правилам" }] };
    const preview = { problem: null, shown: [{ kind: "promo_codes", title: "Промокоды", text: "Промокоды — закрыто бессрочно. Причина: …" }] };
    const { fetch, calls } = fakeFetch(
      json(200, { data: catalog }),
      json(200, { data: { restrictions: [row()] } }),
      json(200, { data: preview }),
      json(201, { data: { restrictions: [row()], revokedSessions: 0 } }),
      json(200, { data: row({ state: "lifted", liftComment: "ошиблись" }) }),
    );
    const api = new AdminApi(fetch);

    expect((await fetchRestrictionCatalog(api)).ok).toBe(true);
    const history = await fetchRestrictions(api, ACCOUNT);
    expect(history.ok && history.data.restrictions[0]?.title).toBe("Промокоды");
    const body = { kinds: ["promo_codes"], endsAt: null, reason: "promo_abuse", notify: true };
    expect((await previewRestriction(api, body)).ok).toBe(true);
    expect((await imposeRestriction(api, ACCOUNT, { ...body, comment: null })).ok).toBe(true);
    expect((await liftRestriction(api, "r1", "ошиблись")).ok).toBe(true);

    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["GET", "/api/v1/admin/restrictions/catalog"],
      ["GET", `/api/v1/admin/players/${ACCOUNT}/restrictions`],
      ["POST", "/api/v1/admin/restrictions/preview"],
      ["POST", `/api/v1/admin/players/${ACCOUNT}/restrictions`],
      ["POST", "/api/v1/admin/restrictions/r1/lift"],
    ]);
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ ...body, comment: null });
    expect(JSON.parse(String(calls[4]?.init.body))).toEqual({ comment: "ошиблись" });
  });
});
