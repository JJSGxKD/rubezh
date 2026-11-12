import { describe, expect, it } from "vitest";
import { SECRETS } from "../src/modules/secrets/secret-catalog.js";
import type { SecretsReader } from "../src/modules/secrets/secrets.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { MaxLinkStarter } from "../src/platforms/max/max-link-starter.js";
import { ExternalLinkStarters } from "../src/platforms/ports/external-link.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Ссылка на бота MAX для связи аккаунтов (docs/35-stage4-plan.md Р188,
 * tasks/T-0379): `https://max.ru/<имя>?start=<код>`. Бот MAX получает код в
 * событии `bot_started`, поэтому ссылка нужна только тогда, когда бот настроен:
 * есть ключ и имя. Чистая функция — по сети не ходит.
 */

const TOKEN = "f9LHodD0cOKoGIx5aSDsQjL_9dKfC1xj6lIhSgkxClhAv6nvLWSOvaCqSbc8jm";
const CODE = "AbCd1234EfGh5678";

/** Ключи панели в памяти: заданный — как значение из базы, остальные не заданы нигде. */
function secretsOf(values: Record<string, string>): SecretsReader {
  return { get: (secret) => values[secret.key] ?? null };
}

describe("ссылка на бота MAX", () => {
  it("есть ключ и имя — ссылка с кодом в параметре start", () => {
    const starter = new MaxLinkStarter(secretsOf({ [SECRETS.maxBotToken.key]: TOKEN }), panelSettings({ [SETTINGS.maxBotUsername.key]: "rubezh_bot" }));

    expect(starter.platform).toBe("max");
    expect(starter.startUrl(CODE)).toBe(`https://max.ru/rubezh_bot?start=${CODE}`);
  });

  it("нет ключа бота — ссылки нет: бот не ответит на старт", () => {
    const starter = new MaxLinkStarter(secretsOf({}), panelSettings({ [SETTINGS.maxBotUsername.key]: "rubezh_bot" }));

    expect(starter.startUrl(CODE)).toBeNull();
  });

  it("нет имени бота — ссылки нет", () => {
    const starter = new MaxLinkStarter(secretsOf({ [SECRETS.maxBotToken.key]: TOKEN }), panelSettings());

    expect(starter.startUrl(CODE)).toBeNull();
  });

  it("нет ни ключа, ни имени — ссылки нет", () => {
    expect(new MaxLinkStarter(secretsOf({}), panelSettings()).startUrl(CODE)).toBeNull();
  });

  it("ключ и имя читаются при каждом вызове: правка в панели действует без перезапуска", () => {
    const values: Record<string, string> = {};
    const settings = panelSettings();
    const starter = new MaxLinkStarter(secretsOf(values), settings);
    expect(starter.startUrl(CODE)).toBeNull();

    values[SECRETS.maxBotToken.key] = TOKEN;
    settings.set(SETTINGS.maxBotUsername.key, "first_bot");
    expect(starter.startUrl(CODE)).toBe(`https://max.ru/first_bot?start=${CODE}`);

    settings.set(SETTINGS.maxBotUsername.key, "second_bot");
    expect(starter.startUrl(CODE)).toBe(`https://max.ru/second_bot?start=${CODE}`);

    delete values[SECRETS.maxBotToken.key];
    expect(starter.startUrl(CODE)).toBeNull();
  });

  it("ключ бота в ссылку не попадает", () => {
    const starter = new MaxLinkStarter(secretsOf({ [SECRETS.maxBotToken.key]: TOKEN }), panelSettings({ [SETTINGS.maxBotUsername.key]: "rubezh_bot" }));

    expect(starter.startUrl(CODE)).not.toContain(TOKEN);
  });
});

describe("стартеры ботов площадок", () => {
  it("адаптер MAX подключает себя к порту: домен находит его по площадке", () => {
    const starters = new ExternalLinkStarters([]);
    expect(starters.for("max")).toBeNull();

    const starter = new MaxLinkStarter(secretsOf({}), panelSettings());
    starters.register(starter);

    expect(starters.for("max")).toBe(starter);
    expect(starters.for("vk")).toBeNull();
  });

  it("повторная регистрация той же площадки заменяет стартер, а не плодит второй", () => {
    const starters = new ExternalLinkStarters([]);
    const first = new MaxLinkStarter(secretsOf({}), panelSettings());
    const second = new MaxLinkStarter(secretsOf({}), panelSettings());

    starters.register(first);
    starters.register(second);

    expect(starters.for("max")).toBe(second);
  });
});
