import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_API_BASE, MaxBotApi } from "../src/platforms/max/max-bot-api.js";
import { MaxChannelMembership } from "../src/platforms/max/max-channel-membership.js";
import { ChannelMemberships, MembershipRejectedError, MembershipUnavailableError } from "../src/platforms/ports/channel-membership.js";

/**
 * Подписка на канал MAX (docs/35-stage4-plan.md Р188, tasks/T-0379): бот —
 * администратор канала, участников спрашивают по `user_ids` через
 * `GET /chats/{chatId}/members`. Пустой ответ — игрок не подписан. Нет канала,
 * бот не администратор, неверный ключ — настройка задания, и повтор не поможет;
 * сеть, 429 и 5xx — «позже». Сеть в тестах — подмена `fetch`.
 */

const TOKEN = "f9LHodD0cOKoGIx5aSDsQjL_9dKfC1xj6lIhSgkxClhAv6nvLWSOvaCqSbc8jm";
const CHANNEL = "-72500190012345";
const PLAYER = "70000000123";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** `fetch` с записью вызовов: что и куда ушло — видно тесту. */
function stub(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return await handler(String(input), init ?? {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function member(userId: number, extra: Record<string, unknown> = {}) {
  return { user_id: userId, first_name: "Анна", is_bot: false, last_activity_time: 1_700_000_000_000, is_owner: false, is_admin: false, join_time: 1_699_000_000_000, ...extra };
}

function membershipOf(handler: Handler, tokenOf: () => string | null = () => TOKEN) {
  const { calls, fetchImpl } = stub(handler);
  return { calls, membership: new MaxChannelMembership(new MaxBotApi(tokenOf, fetchImpl)) };
}

describe("подписка на канал MAX", () => {
  it("игрок в ответе — подписан; запрос идёт по user_ids, ключ — в заголовке Authorization", async () => {
    const { calls, membership } = membershipOf(() => json({ members: [member(Number(PLAYER))], marker: null }));

    await expect(membership.isMember(CHANNEL, PLAYER)).resolves.toBe(true);

    expect(membership.platform).toBe("max");
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(`${MAX_API_BASE}/chats/${CHANNEL}/members`);
    expect(url.searchParams.get("user_ids")).toBe(PLAYER);
    expect(calls[0]?.init.method).toBe("GET");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(TOKEN);
  });

  it("пустой ответ — не подписан", async () => {
    const { membership } = membershipOf(() => json({ members: [], marker: null }));

    await expect(membership.isMember(CHANNEL, PLAYER)).resolves.toBe(false);
  });

  it("в ответе другой участник — не подписан: фильтр площадки не принимается на веру", async () => {
    const { membership } = membershipOf(() => json({ members: [member(1), member(2)], marker: 3 }));

    await expect(membership.isMember(CHANNEL, PLAYER)).resolves.toBe(false);
  });

  it("id игрока не из MAX (`dev-…` у разработчика) — не подписан, площадку не спрашивают", async () => {
    const { calls, membership } = membershipOf(() => json({ members: [] }));

    await expect(membership.isMember(CHANNEL, "dev-42")).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it.each([
    ["бот не администратор канала (403)", 403, { code: "access.denied", message: "Forbidden" }],
    ["канала нет (404)", 404, { code: "chat.not.found", message: "Chat not found" }],
    ["неверный ключ (401)", 401, { code: "verify.token", message: "Invalid access_token" }],
    ["запрос не принят (400)", 400, { code: "proceed.error", message: "Bad request" }],
  ])("%s — ошибка настройки задания: MembershipRejectedError", async (_name, status, body) => {
    const { membership } = membershipOf(() => json(body, status));

    await expect(membership.isMember(CHANNEL, PLAYER)).rejects.toBeInstanceOf(MembershipRejectedError);
  });

  it.each([
    ["слишком много запросов (429)", 429],
    ["внутренняя ошибка MAX (500)", 500],
    ["шлюз недоступен (503)", 503],
  ])("%s — площадка не ответила: MembershipUnavailableError", async (_name, status) => {
    const { membership } = membershipOf(() => json({ code: "internal.error", message: "later" }, status));

    await expect(membership.isMember(CHANNEL, PLAYER)).rejects.toBeInstanceOf(MembershipUnavailableError);
  });

  it("таймаут запроса — MembershipUnavailableError", async () => {
    const { membership } = membershipOf(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    await expect(membership.isMember(CHANNEL, PLAYER)).rejects.toBeInstanceOf(MembershipUnavailableError);
  });

  it("обрыв сети — MembershipUnavailableError", async () => {
    const { membership } = membershipOf(() => {
      throw new TypeError("fetch failed");
    });

    await expect(membership.isMember(CHANNEL, PLAYER)).rejects.toBeInstanceOf(MembershipUnavailableError);
  });

  it("ответ не по схеме — MembershipUnavailableError: понятного ответа от площадки нет", async () => {
    const { membership } = membershipOf(() => json({ members: "не список" }));

    await expect(membership.isMember(CHANNEL, PLAYER)).rejects.toBeInstanceOf(MembershipUnavailableError);
  });

  it("у запроса есть потолок времени", async () => {
    const { calls, membership } = membershipOf(() => json({ members: [] }));

    await membership.isMember(CHANNEL, PLAYER);

    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("ключа бота нет — MembershipUnavailableError, в MAX не ходим", async () => {
    const { calls, membership } = membershipOf(() => json({ members: [] }), () => null);

    await expect(membership.isMember(CHANNEL, PLAYER)).rejects.toBeInstanceOf(MembershipUnavailableError);
    expect(calls).toEqual([]);
  });

  it("ключ читается при каждой проверке: замена в панели действует сразу", async () => {
    let token: string | null = TOKEN;
    const { calls, membership } = membershipOf(() => json({ members: [] }), () => token);
    await membership.isMember(CHANNEL, PLAYER);

    token = "second-token-from-panel-0123456789abcdef";
    await membership.isMember(CHANNEL, PLAYER);

    expect(calls.map((call) => new Headers(call.init.headers).get("authorization"))).toEqual([TOKEN, "second-token-from-panel-0123456789abcdef"]);
  });

  it("канал в записи не числом — MembershipRejectedError без запроса: так в задании канал не называют", async () => {
    const { calls, membership } = membershipOf(() => json({ members: [] }));

    await expect(membership.isMember("@rubezh", PLAYER)).rejects.toBeInstanceOf(MembershipRejectedError);
    await expect(membership.isMember("../me", PLAYER)).rejects.toBeInstanceOf(MembershipRejectedError);
    expect(calls).toEqual([]);
  });
});

describe("ключ бота MAX не попадает ни в адрес, ни в лог, ни в ошибку", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((line: unknown) => void logged.push(String(line)));
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["403", () => json({ code: "access.denied", message: "Forbidden" }, 403)],
    ["500", () => json({ code: "internal.error", message: "boom" }, 500)],
    [
      "обрыв сети",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    [
      "таймаут",
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    ],
  ])("%s", async (_name, handler) => {
    const { calls, membership } = membershipOf(handler);

    const error = await membership.isMember(CHANNEL, PLAYER).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });
});

describe("проверки подписки всех площадок", () => {
  it("адаптер MAX подключает себя к порту: домен находит его по площадке", () => {
    const memberships = new ChannelMemberships([]);
    expect(memberships.for("max")).toBeNull();

    const { membership } = membershipOf(() => json({ members: [] }));
    memberships.register(membership);

    expect(memberships.for("max")).toBe(membership);
    expect(memberships.for("vk")).toBeNull();
  });

  it("повторная регистрация той же площадки заменяет проверку, не трогая остальные", () => {
    const telegram = { platform: "telegram" as const, isMember: async () => true };
    const memberships = new ChannelMemberships([telegram]);
    const first = membershipOf(() => json({ members: [] })).membership;
    const second = membershipOf(() => json({ members: [] })).membership;

    memberships.register(first);
    memberships.register(second);

    expect(memberships.for("max")).toBe(second);
    expect(memberships.for("telegram")).toBe(telegram);
  });
});
