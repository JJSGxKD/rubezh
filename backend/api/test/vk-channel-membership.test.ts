import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECRETS, VK_API_VERSION, type SecretDefinition } from "../src/modules/secrets/secret-catalog.js";
import type { SecretsReader } from "../src/modules/secrets/secrets.service.js";
import { SETTINGS, type SettingDefinition } from "../src/modules/settings/setting-catalog.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import { loadAppConfig } from "../src/config/app-config.js";
import { channelMembershipsFor } from "../src/platforms/platforms.module.js";
import { MembershipRejectedError, MembershipUnavailableError } from "../src/platforms/ports/channel-membership.js";
import { VkApi, VkApiError } from "../src/platforms/vk/vk-api.js";
import { VkChannelMembership } from "../src/platforms/vk/vk-channel-membership.js";
import { VkCommunity } from "../src/platforms/vk/vk-community.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Вступление в сообщество VK (docs/35-stage4-plan.md Р188, tasks/T-0378):
 * `groups.isMember` ключом сообщества. Сеть подменена `fetch`: ответы VK —
 * всегда HTTP 200, а ошибка лежит в теле (`error.error_code`).
 */

const TOKEN = "vk1.a.TestCommunityTokenWithEnoughSymbols0123456789";
const USER = "555000111";

interface Call {
  url: string;
  init: RequestInit;
  params: URLSearchParams;
}

type Handler = (call: Call) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function vkError(code: number, message = "ошибка"): Response {
  return json({ error: { error_code: code, error_msg: message, request_params: [] } });
}

function setup(handler: Handler, token: string | null = TOKEN) {
  const calls: Call[] = [];
  const secrets: SecretsReader = { get: (secret: SecretDefinition) => (secret.key === SECRETS.vkCommunityToken.key ? token : null) };
  const settings = { get: (setting: SettingDefinition) => (setting.key === SETTINGS.vkCommunity.key ? "rubezh_game" : setting.fallback) } as unknown as Pick<SettingsReader, "get">;
  const community = new VkCommunity(secrets, settings);
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const params = new URLSearchParams(String(init?.body ?? ""));
    const call = { url, init: init ?? {}, params };
    calls.push(call);
    return await handler(call);
  }) as typeof fetch;
  const api = new VkApi(community, fetchImpl, () => 424242);
  return { calls, api, check: new VkChannelMembership(api) };
}

/** Всё, что попало в лог Nest и в консоль, одной строкой. */
function captureLogs(): () => string {
  const lines: string[] = [];
  const record = (...args: unknown[]): undefined => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    return undefined;
  };
  for (const level of ["log", "warn", "error", "debug", "verbose"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(record);
  for (const level of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, level).mockImplementation(record);
  return () => lines.join("\n");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("вступление в сообщество VK: groups.isMember", () => {
  it("ответ 1 — состоит, 0 — нет; запрос — метод, сообщество, игрок и версия API", async () => {
    let answer = 1;
    const { calls, check } = setup(() => json({ response: answer }));

    expect(await check.isMember("rubezh_game", USER)).toBe(true);
    answer = 0;
    expect(await check.isMember("rubezh_game", USER)).toBe(false);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://api.vk.com/method/groups.isMember");
    expect(calls[0]?.init.method).toBe("POST");
    expect(Object.fromEntries(calls[0]?.params ?? [])).toMatchObject({ group_id: "rubezh_game", user_id: USER, v: VK_API_VERSION });
  });

  it("сообщество в задании — имя, ссылка, club<id> или число: VK получает имя или числовой id", async () => {
    const { calls, check } = setup(() => json({ response: 1 }));
    for (const chat of ["rubezh_game", "https://vk.com/rubezh_game", "@rubezh_game", "club123456", "public123456", "123456"]) await check.isMember(chat, USER);
    expect(calls.map((call) => call.params.get("group_id"))).toEqual(["rubezh_game", "rubezh_game", "rubezh_game", "123456", "123456", "123456"]);
  });

  it("игрок не из VK (`dev-…`, не число): не состоит, VK не спрашиваем", async () => {
    const { calls, check } = setup(() => json({ response: 1 }));
    expect(await check.isMember("rubezh_game", "dev-abc")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("VK не знает такого игрока (113) — не состоит, а не ошибка", async () => {
    const { check } = setup(() => vkError(113, "Invalid user id"));
    expect(await check.isMember("rubezh_game", USER)).toBe(false);
  });

  it("ошибки доступа VK — настройка задания: неверный ключ, нет прав, сообщество не найдено", async () => {
    for (const code of [5, 7, 15, 27, 28, 100, 125, 203]) {
      const { check } = setup(() => vkError(code));
      await expect(check.isMember("rubezh_game", USER), `код ${String(code)}`).rejects.toBeInstanceOf(MembershipRejectedError);
    }
  });

  it("лимиты и сбои VK — позже: повтор может помочь", async () => {
    for (const code of [1, 6, 9, 10, 29, 9999]) {
      const { check } = setup(() => vkError(code));
      await expect(check.isMember("rubezh_game", USER), `код ${String(code)}`).rejects.toBeInstanceOf(MembershipUnavailableError);
    }
  });

  it("5xx, непонятный ответ и обрыв сети — позже", async () => {
    await expect(setup(() => new Response("bad gateway", { status: 502 })).check.isMember("rubezh_game", USER)).rejects.toBeInstanceOf(MembershipUnavailableError);
    await expect(setup(() => json({}, 500)).check.isMember("rubezh_game", USER)).rejects.toBeInstanceOf(MembershipUnavailableError);
    await expect(setup(() => new Response("<html>", { status: 200 })).check.isMember("rubezh_game", USER)).rejects.toBeInstanceOf(MembershipUnavailableError);
    await expect(setup(() => json({ response: "yes" })).check.isMember("rubezh_game", USER)).rejects.toBeInstanceOf(MembershipUnavailableError);
    await expect(
      setup(() => {
        throw new TypeError("fetch failed");
      }).check.isMember("rubezh_game", USER),
    ).rejects.toBeInstanceOf(MembershipUnavailableError);
  });

  it("таймаут — позже; у запроса есть срок", async () => {
    const { calls, check } = setup(() => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    await expect(check.isMember("rubezh_game", USER)).rejects.toBeInstanceOf(MembershipUnavailableError);
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("нет ключа сообщества — спросить некого: позже, VK не трогаем", async () => {
    const { calls, check } = setup(() => json({ response: 1 }), null);
    await expect(check.isMember("rubezh_game", USER)).rejects.toBeInstanceOf(MembershipUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("ключ — в теле запроса, а не в адресе; в лог и в текст ошибки не попадает", async () => {
    const logs = captureLogs();
    const { calls, check } = setup(({ params }) => vkError(params.get("access_token") === TOKEN ? 5 : 1, "User authorization failed"));

    const failure = await check.isMember("rubezh_game", USER).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MembershipRejectedError);
    expect(String((failure as Error).message)).not.toContain(TOKEN);
    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(calls[0]?.url).not.toContain("access_token");
    expect(calls[0]?.params.get("access_token")).toBe(TOKEN);
    expect(JSON.stringify(calls[0]?.init.headers ?? {})).not.toContain(TOKEN);
    expect(logs()).not.toContain(TOKEN);
  });

  it("VK подключает проверку к порту сам; до подключения VK в сборке нет", () => {
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
    const telegram = { getChatMember: async () => ({ status: "member", isMember: null }) };
    const { check } = setup(() => json({ response: 1 }));
    const memberships = channelMembershipsFor(config, telegram);
    expect(memberships.for("vk")).toBeNull();
    memberships.register(check);
    expect(memberships.for("vk")).toBe(check);
    expect(memberships.for("telegram")).not.toBeNull();
  });
});

describe("сообщения сообщества: messages.send", () => {
  const KEYBOARD = { inline: true, buttons: [[{ action: { type: "open_link", link: "https://vk.com/rubezh_game", label: "Перейти в сообщество" } }]] } as const;

  it("шлёт игроку текст: метод, получатель, случайный random_id; кнопка — JSON-строкой", async () => {
    const { calls, api } = setup(() => json({ response: 77 }));

    await api.sendMessage("555000111", "Привет", KEYBOARD);

    expect(calls[0]?.url).toBe("https://api.vk.com/method/messages.send");
    expect(Object.fromEntries(calls[0]?.params ?? [])).toMatchObject({ user_id: "555000111", message: "Привет", random_id: "424242", v: VK_API_VERSION, access_token: TOKEN });
    expect(JSON.parse(calls[0]?.params.get("keyboard") ?? "null")).toEqual(KEYBOARD);
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it("random_id по умолчанию — целое int32, разное у разных сообщений", async () => {
    const calls: Call[] = [];
    const secrets: SecretsReader = { get: () => TOKEN };
    const settings = { get: (setting: SettingDefinition) => setting.fallback } as unknown as Pick<SettingsReader, "get">;
    const api = new VkApi(new VkCommunity(secrets, settings), (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {}, params: new URLSearchParams(String(init?.body ?? "")) });
      return json({ response: 1 });
    }) as typeof fetch);
    for (let index = 0; index < 5; index++) await api.sendMessage("555000111", "Привет");
    const ids = calls.map((call) => Number(call.params.get("random_id")));
    for (const id of ids) {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(2 ** 31 - 1);
    }
    expect(new Set(ids).size).toBeGreaterThan(1);
  });

  it("у сообщества выключены кнопки ботов (912): то же сообщение уходит без кнопки", async () => {
    const { calls, api } = setup(({ params }) => (params.has("keyboard") ? vkError(912, "This is a chat bot feature, change this status in settings") : json({ response: 78 })));

    await api.sendMessage("555000111", "Привет", KEYBOARD);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.params.has("keyboard")).toBe(true);
    expect(calls[1]?.params.has("keyboard")).toBe(false);
    expect(calls[1]?.params.get("message")).toBe("Привет");
  });

  it("игрок запретил сообщения (901) и прочие отказы — ошибка с кодом, без повтора", async () => {
    const { calls, api } = setup(() => vkError(901, "Can't send messages for users without permission"));
    const failure = await api.sendMessage("555000111", "Привет", KEYBOARD).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VkApiError);
    expect((failure as VkApiError).code).toBe(901);
    expect(calls).toHaveLength(1);
  });

  it("обрыв сети при отправке — ошибка, ключ в ней не светится", async () => {
    const logs = captureLogs();
    const { api } = setup(() => {
      throw new TypeError("fetch failed");
    });
    const failure = await api.sendMessage("555000111", "Привет").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VkApiError);
    expect(String((failure as Error).message)).not.toContain(TOKEN);
    expect(logs()).not.toContain(TOKEN);
  });
});

describe("числовой id сообщества: groups.getById", () => {
  it("по короткому имени берёт id и помнит его — второй запрос не нужен", async () => {
    const { calls, api } = setup(() => json({ response: { groups: [{ id: 123456, screen_name: "rubezh_game", name: "Рубеж" }] } }));
    expect(await api.groupId("rubezh_game")).toBe("123456");
    expect(await api.groupId("rubezh_game")).toBe("123456");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.vk.com/method/groups.getById");
    expect(calls[0]?.params.get("group_id")).toBe("rubezh_game");
  });

  it("старый вид ответа — массив — тоже читается", async () => {
    const { api } = setup(() => json({ response: [{ id: 99, screen_name: "rubezh_game" }] }));
    expect(await api.groupId("rubezh_game")).toBe("99");
  });

  it("сообщества нет — ошибка доступа, не «позже»", async () => {
    const { api } = setup(() => vkError(100, "group_ids is undefined"));
    await expect(api.groupId("no_such_group")).rejects.toBeInstanceOf(VkApiError);
  });
});
