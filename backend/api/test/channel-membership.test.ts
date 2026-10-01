import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { channelMembershipsFor } from "../src/platforms/platforms.module.js";
import { MembershipRejectedError, MembershipUnavailableError } from "../src/platforms/ports/channel-membership.js";
import { TelegramApiError } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramChannelMembership, type MembershipBotApi } from "../src/platforms/telegram/telegram-channel-membership.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

// Подписка на канал через порт (docs/35-stage4-plan.md Р52): домен получает
// «состоит / не состоит» и ошибки порта, а что значит ответ Bot API, знает
// адаптер Telegram.

class FakeMemberApi implements MembershipBotApi {
  readonly asked: [string, number][] = [];
  answer: { status: string; isMember: boolean | null } = { status: "member", isMember: null };
  failWith: Error | null = null;

  async getChatMember(chat: string, userId: number): Promise<{ status: string; isMember: boolean | null }> {
    this.asked.push([chat, userId]);
    if (this.failWith !== null) throw this.failWith;
    return this.answer;
  }
}

function membership(api = new FakeMemberApi(), enabled = true) {
  return { api, check: new TelegramChannelMembership(api, enabled) };
}

describe("подписка на канал Telegram", () => {
  it("участник, администратор и владелец — состоят; вышедший и выгнанный — нет", async () => {
    const { api, check } = membership();
    for (const [status, joined] of [
      ["member", true],
      ["administrator", true],
      ["creator", true],
      ["left", false],
      ["kicked", false],
    ] as const) {
      api.answer = { status, isMember: null };
      expect(await check.isMember("@rubezh_game", "555000111"), status).toBe(joined);
    }
    expect(api.asked[0]).toEqual(["@rubezh_game", 555000111]);
  });

  it("ограниченный — по признаку участия: ограничен в правах, но не вышел", async () => {
    const { api, check } = membership();
    api.answer = { status: "restricted", isMember: true };
    expect(await check.isMember("@rubezh_game", "555000111")).toBe(true);
    api.answer = { status: "restricted", isMember: false };
    expect(await check.isMember("@rubezh_game", "555000111")).toBe(false);
    api.answer = { status: "restricted", isMember: null };
    expect(await check.isMember("@rubezh_game", "555000111")).toBe(false);
  });

  it("статус, которого адаптер не знает, — не подписан: награду не выдаём наугад", async () => {
    const { api, check } = membership();
    api.answer = { status: "ghost", isMember: true };
    expect(await check.isMember("@rubezh_game", "555000111")).toBe(false);
  });

  it("аккаунт разработчика в Telegram не существует — ни в каком канале, и Bot API не спрашивается", async () => {
    const { api, check } = membership();
    expect(await check.isMember("@rubezh_game", "dev-1")).toBe(false);
    expect(api.asked).toHaveLength(0);
  });

  it("Telegram не знает игрока в чате — не подписан", async () => {
    const { api, check } = membership();
    api.failWith = new TelegramApiError("getChatMember", 400, "Bad Request: USER_NOT_PARTICIPANT", null);
    expect(await check.isMember("@rubezh_game", "555000111")).toBe(false);
    api.failWith = new TelegramApiError("getChatMember", 400, "Bad Request: PARTICIPANT_ID_INVALID", null);
    expect(await check.isMember("@rubezh_game", "555000111")).toBe(false);
  });

  it("канала нет или бот в нём не администратор — ошибка настройки, а не «не подписан»", async () => {
    const { api, check } = membership();
    api.failWith = new TelegramApiError("getChatMember", 400, "Bad Request: chat not found", null);
    await expect(check.isMember("@nope", "555000111")).rejects.toBeInstanceOf(MembershipRejectedError);
    api.failWith = new TelegramApiError("getChatMember", 403, "Forbidden: bot is not a member of the channel chat", null);
    await expect(check.isMember("@rubezh_game", "555000111")).rejects.toBeInstanceOf(MembershipRejectedError);
  });

  it("сеть, лимит, сбой Telegram — временно недоступно", async () => {
    const { api, check } = membership();
    api.failWith = new TelegramApiError("getChatMember", 0, "сеть недоступна", null);
    await expect(check.isMember("@rubezh_game", "555000111")).rejects.toBeInstanceOf(MembershipUnavailableError);
    api.failWith = new TelegramApiError("getChatMember", 429, "Too Many Requests", 3);
    await expect(check.isMember("@rubezh_game", "555000111")).rejects.toBeInstanceOf(MembershipUnavailableError);
    api.failWith = new TelegramApiError("getChatMember", 502, "Bad Gateway", null);
    await expect(check.isMember("@rubezh_game", "555000111")).rejects.toBeInstanceOf(MembershipUnavailableError);
  });

  it("без бота спросить некого — недоступно, Bot API не трогаем", async () => {
    const { api, check } = membership(new FakeMemberApi(), false);
    await expect(check.isMember("@rubezh_game", "555000111")).rejects.toBeInstanceOf(MembershipUnavailableError);
    expect(api.asked).toHaveLength(0);
  });

  it("проверка есть у Telegram; у площадок без бота её нет", () => {
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
    const memberships = channelMembershipsFor(config, new FakeMemberApi());
    expect(memberships.for("telegram")).toBeInstanceOf(TelegramChannelMembership);
    expect(memberships.for("max")).toBeNull();
    expect(memberships.for("vk")).toBeNull();
  });
});
