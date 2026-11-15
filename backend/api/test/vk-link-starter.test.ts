import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { SECRETS, secretProblem, type SecretDefinition } from "../src/modules/secrets/secret-catalog.js";
import type { SecretsReader } from "../src/modules/secrets/secrets.service.js";
import { SETTINGS, parseVkCommunity, type SettingDefinition } from "../src/modules/settings/setting-catalog.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import { LINK_CODE_PATTERN, newLinkCode } from "../src/modules/external-identity/external-identity-rules.js";
import { externalLinkStartersFor } from "../src/modules/external-identity/external-identity.module.js";
import { ChannelMemberships } from "../src/platforms/ports/channel-membership.js";
import type { VkApi } from "../src/platforms/vk/vk-api.js";
import { VkChannelMembership } from "../src/platforms/vk/vk-channel-membership.js";
import { VkCommunity } from "../src/platforms/vk/vk-community.js";
import { VkLinkStarter } from "../src/platforms/vk/vk-link-starter.js";
import { VkModule } from "../src/platforms/vk/vk.module.js";

/**
 * Ссылка на бота сообщества VK для связи аккаунтов (docs/35-stage4-plan.md
 * Р188, tasks/T-0378): `https://vk.me/<сообщество>?ref=<код>`. Ссылка строится
 * из ключа сообщества и настройки `vk.community` и ничего не читает по сети.
 */

const TOKEN = "vk1.a.TestCommunityTokenWithEnoughSymbols0123456789";

function community(token: string | null, name: string): VkCommunity {
  const secrets: SecretsReader = { get: (secret: SecretDefinition) => (secret.key === SECRETS.vkCommunityToken.key ? token : null) };
  const settings = {
    get: (setting: SettingDefinition) => (setting.key === SETTINGS.vkCommunity.key ? name : setting.fallback),
  } as unknown as Pick<SettingsReader, "get">;
  return new VkCommunity(secrets, settings);
}

describe("ссылка на бота сообщества VK", () => {
  it("есть ключ и настройка — vk.me с кодом в ref", () => {
    const code = newLinkCode();
    const starter = new VkLinkStarter(community(TOKEN, "https://vk.com/rubezh_game"));
    expect(starter.platform).toBe("vk");
    expect(starter.startUrl(code)).toBe(`https://vk.me/rubezh_game?ref=${code}`);
  });

  it("настройку можно задать ссылкой, коротким именем или club<id>", () => {
    for (const [value, name] of [
      ["https://vk.com/rubezh_game", "rubezh_game"],
      ["https://m.vk.com/rubezh_game", "rubezh_game"],
      ["rubezh_game", "rubezh_game"],
      ["https://vk.com/club123456", "club123456"],
      ["club123456", "club123456"],
    ] as const) {
      expect(new VkLinkStarter(community(TOKEN, value)).startUrl("AbCd1234AbCd1234"), value).toBe(`https://vk.me/${name}?ref=AbCd1234AbCd1234`);
    }
  });

  it("нет ключа сообщества — ссылки нет: канал VK игрокам не показывается", () => {
    expect(new VkLinkStarter(community(null, "rubezh_game")).startUrl(newLinkCode())).toBeNull();
  });

  it("нет настройки или в ней мусор — ссылки нет", () => {
    for (const value of ["", "   ", "не сообщество", "http://vk.com/rubezh_game", "https://example.com/rubezh_game", "https://vk.com/a/b", "https://vk.com/rubezh?x=1"]) {
      expect(new VkLinkStarter(community(TOKEN, value)).startUrl(newLinkCode()), value).toBeNull();
    }
  });

  it("нет обоих — ссылки нет", () => {
    expect(new VkLinkStarter(community(null, "")).startUrl(newLinkCode())).toBeNull();
  });

  it("настройка читается при каждом показе: смена в панели действует без перезапуска", () => {
    let name = "first_group";
    const settings = { get: (setting: SettingDefinition) => (setting.key === SETTINGS.vkCommunity.key ? name : setting.fallback) } as unknown as Pick<SettingsReader, "get">;
    const starter = new VkLinkStarter(new VkCommunity({ get: () => TOKEN }, settings));
    expect(starter.startUrl("AbCd1234AbCd1234")).toContain("/first_group?");
    name = "second_group";
    expect(starter.startUrl("AbCd1234AbCd1234")).toContain("/second_group?");
  });

  it("код из выдачи подходит под правило кода: ref не ломается в ссылке", () => {
    const code = newLinkCode();
    expect(code).toMatch(LINK_CODE_PATTERN);
    expect(new URL(new VkLinkStarter(community(TOKEN, "rubezh_game")).startUrl(code) ?? "").searchParams.get("ref")).toBe(code);
  });

  it("модуль VK при старте подключает стартер и проверку вступления к портам; до старта VK в портах нет", () => {
    const starters = externalLinkStartersFor();
    const memberships = new ChannelMemberships([]);
    const vkCommunity = community(TOKEN, "rubezh_game");
    const module = new VkModule({ isMember: async () => true } as unknown as VkApi, vkCommunity, memberships, starters);
    expect(starters.for("vk")).toBeNull();
    expect(memberships.for("vk")).toBeNull();
    module.onModuleInit();
    expect(starters.for("vk")).toBeInstanceOf(VkLinkStarter);
    expect(starters.for("vk")?.startUrl("abc")).toBe("https://vk.me/rubezh_game?ref=abc");
    expect(memberships.for("vk")).toBeInstanceOf(VkChannelMembership);
  });
});

describe("сообщество VK в настройке", () => {
  it("короткое имя, club<id> и public<id>: числовой id — только у цифровых видов", () => {
    expect(parseVkCommunity("rubezh_game")).toEqual({ screenName: "rubezh_game", id: null, url: "https://vk.com/rubezh_game" });
    expect(parseVkCommunity("club123456")).toEqual({ screenName: "club123456", id: "123456", url: "https://vk.com/club123456" });
    expect(parseVkCommunity("public77")).toEqual({ screenName: "public77", id: "77", url: "https://vk.com/public77" });
    expect(parseVkCommunity("123456")).toEqual({ screenName: "club123456", id: "123456", url: "https://vk.com/club123456" });
    expect(parseVkCommunity("@rubezh_game")?.screenName).toBe("rubezh_game");
  });

  it("не сообщество — null", () => {
    for (const raw of ["", " ", "a", "с кириллицей", "https://vk.com/", "https://vk.com/a/b", "ftp://vk.com/x", "https://example.com/rubezh_game"]) {
      expect(parseVkCommunity(raw), raw).toBeNull();
    }
  });

  it("схема настройки пускает пустое значение, ссылку и имя, остальное отклоняет", () => {
    const schema = SETTINGS.vkCommunity.schema;
    expect(SETTINGS.vkCommunity.key).toBe("vk.community");
    expect(SETTINGS.vkCommunity.fallback).toBe("");
    expect((SETTINGS.vkCommunity as SettingDefinition).fromEnv(loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv))).toBeNull();
    for (const ok of ["", "https://vk.com/rubezh_game", "rubezh_game", "club123456"]) expect(schema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["http://vk.com/x", "https://example.com/x", "два слова", "https://vk.com/a/b"]) expect(schema.safeParse(bad).success, bad).toBe(false);
  });

  it("ключи VK в каталоге: вид ключа проверяется до записи", () => {
    expect(secretProblem(SECRETS.vkCommunityToken, SECRETS.vkCommunityToken.example)).toBeNull();
    expect(secretProblem(SECRETS.vkCommunityToken, "short")).not.toBeNull();
    expect(secretProblem(SECRETS.vkCallbackSecret, SECRETS.vkCallbackSecret.example)).toBeNull();
    expect(secretProblem(SECRETS.vkCallbackSecret, "с-дефисом-и-слишком-короткий")).not.toBeNull();
    expect(secretProblem(SECRETS.vkCallbackConfirmation, "a1b2c3d4")).toBeNull();
    expect(secretProblem(SECRETS.vkCallbackConfirmation, "x".repeat(33))).not.toBeNull();
  });
});
