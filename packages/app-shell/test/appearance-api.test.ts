import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createFriendsApi } from "../src/state/friends-api";
import { leaderboardSchema } from "../src/state/runs-api";
import { APPEARANCE_LOCKED, APPEARANCE_NOT_FOUND, appearanceFailure, createAppearanceApi } from "../src/state/appearance-api";

// Клиент раздела «Облик» (tasks/T-0238, tasks/T-0237): ответ сервера — граница
// системы и разбирается схемой; выбор не оптимистичный, коды отказа доходят
// до экрана.

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

const KEEPER = { id: "keeper", archetype: "keeper", rarity: "common", held: true, source: { kind: "start" } };
const FROST = { id: "frost", archetype: "keeper", rarity: "common", held: true, source: { kind: "level", level: 5 } };
const OHOTNITSA = { id: "ohotnitsa", archetype: "ohotnitsa", rarity: "epic", held: false, source: { kind: "achievement", achievementId: "ach_elite_50", title: "Гроза элит" } };
const NAVI = { id: "navi", archetype: "navi", rarity: "mythic", held: false, source: { kind: "season", maxPlace: 3 } };

describe("раздел «Облик»", () => {
  it("ответ с полученным, закрытым и сезонным обликом разбирается; запрос — GET без тела", async () => {
    const sent: Sent[] = [];
    const answer = { selected: "frost", effective: "frost", avatarPhoto: false, items: [KEEPER, FROST, OHOTNITSA, NAVI] };

    const response = await createAppearanceApi(server(sent, answer)).load();

    expect(sent).toEqual([{ method: "GET", path: "/api/v1/appearance", body: undefined }]);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.effective).toBe("frost");
    expect(response.data.avatarPhoto).toBe(false);
    expect(response.data.items.map((item) => item.held)).toEqual([true, true, false, false]);
    expect(response.data.items[2]?.source).toMatchObject({ kind: "achievement", title: "Гроза элит" });
    expect(response.data.items[3]?.source).toMatchObject({ kind: "season", maxPlace: 3 });
  });

  it("незнакомые источник, архетип и редкость не роняют раздел: сервер новее клиента", async () => {
    const future = { id: "future", archetype: "dragon", rarity: "cosmic", held: false, source: { kind: "lottery", ticket: 7 } };

    const response = await createAppearanceApi(server([], { selected: "keeper", effective: "keeper", avatarPhoto: false, items: [KEEPER, future] })).load();

    expect(response.ok).toBe(true);
  });

  it("битый ответ — отказ схемы, а не молча пустой раздел", async () => {
    const noItems = await createAppearanceApi(server([], { selected: "keeper", effective: "keeper", avatarPhoto: false })).load();
    const badHeld = await createAppearanceApi(server([], { selected: "keeper", effective: "keeper", avatarPhoto: false, items: [{ ...KEEPER, held: "да" }] })).load();
    const noEffective = await createAppearanceApi(server([], { selected: "keeper", avatarPhoto: false, items: [KEEPER] })).load();

    expect(noItems.ok).toBe(false);
    expect(badHeld.ok).toBe(false);
    expect(noEffective.ok).toBe(false);
  });
});

describe("выбор облика", () => {
  it("облик выбирается PUT с `id`; ответ — что действует теперь", async () => {
    const sent: Sent[] = [];

    const response = await createAppearanceApi(server(sent, { selected: "vityaz", effective: "vityaz", avatarPhoto: false })).choose({ id: "vityaz" });

    expect(sent).toEqual([{ method: "PUT", path: "/api/v1/appearance", body: { id: "vityaz" } }]);
    expect(response.ok && response.data).toEqual({ selected: "vityaz", effective: "vityaz", avatarPhoto: false });
  });

  it("переключатель кружка — PUT с `avatarPhoto`, без `id`", async () => {
    const sent: Sent[] = [];

    const response = await createAppearanceApi(server(sent, { selected: "keeper", effective: "keeper", avatarPhoto: true })).choose({ avatarPhoto: true });

    expect(sent).toEqual([{ method: "PUT", path: "/api/v1/appearance", body: { avatarPhoto: true } }]);
    expect(response.ok && response.data.avatarPhoto).toBe(true);
  });

  it("409 с кодом `appearance_locked` доходит до экрана кодом, а не обезличенным отказом", async () => {
    const refusing: ApiRequest = async <T,>(): Promise<ApiResult<T>> => ({ ok: false, failure: "unavailable", code: "appearance_locked" });

    const response = await createAppearanceApi(refusing).choose({ id: "knyaz" });

    expect(response).toEqual({ ok: false, failure: "unavailable", code: APPEARANCE_LOCKED });
    expect(APPEARANCE_LOCKED).toBe("appearance_locked");
    expect(APPEARANCE_NOT_FOUND).toBe("appearance_not_found");
  });

  it("оба кода отказа — «состояние разошлось, перечитай»; прочие — нет; текст один", () => {
    expect(appearanceFailure("appearance_locked")).toEqual({ textKey: "appearance.chooseFailed", reload: true });
    expect(appearanceFailure("appearance_not_found")).toEqual({ textKey: "appearance.chooseFailed", reload: true });
    expect(appearanceFailure("rate_limited")).toEqual({ textKey: "appearance.chooseFailed", reload: false });
    expect(appearanceFailure(undefined)).toEqual({ textKey: "appearance.chooseFailed", reload: false });
  });
});

describe("облик в строке списка", () => {
  const row = { rank: 1, name: "Аня", photoUrl: null, survivalSec: 600, level: 5, startingWeaponId: "bolt", enemiesKilled: 10, isMe: false };
  const board = (extra: Record<string, unknown>) => ({ difficultyId: "hard", entries: [{ ...row, ...extra }], me: null, totalPlayers: 1 });

  it("рейтинг: `appearance` и `avatarPhoto` необязательны и разбираются", () => {
    expect(leaderboardSchema.safeParse(board({})).success).toBe(true);
    const parsed = leaderboardSchema.safeParse(board({ appearance: "vityaz", avatarPhoto: true }));
    expect(parsed.success && parsed.data.entries[0]?.appearance).toBe("vityaz");
    expect(parsed.success && parsed.data.entries[0]?.avatarPhoto).toBe(true);
    expect(leaderboardSchema.safeParse(board({ appearance: 5 })).success).toBe(false);
  });

  it("друзья: у друга и у заявки облик необязателен", async () => {
    const view = {
      friends: [{ accountId: "f1", displayName: "Дым", photoUrl: null, since: "2026-09-29T10:00:00.000Z", source: "link", appearance: "knyaz", avatarPhoto: true }],
      incoming: [{ accountId: "r1", displayName: "Лис", photoUrl: null, at: "2026-09-30T08:00:00.000Z" }],
      outgoing: [],
      limits: { maxFriends: 100 },
      gifts: { sentToday: [], pending: 0, claimableToday: 0, coins: 20 },
      bonus: { qualified: 0, steps: [], readyCoins: 0 },
    };
    const request: ApiRequest = async <T,>(_path: string, schema: object): Promise<ApiResult<T>> => {
      const { z } = await import("zod/mini");
      const parsed = z.object({ data: schema as never }).safeParse({ data: view });
      return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
    };

    const response = await createFriendsApi(request).view();

    expect(response.ok && response.data.friends[0]?.appearance).toBe("knyaz");
    expect(response.ok && response.data.friends[0]?.avatarPhoto).toBe(true);
    expect(response.ok && response.data.incoming[0]?.appearance).toBeUndefined();
  });
});
