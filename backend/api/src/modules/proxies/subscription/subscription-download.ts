import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fetchSubscription, isPublicAddress, type FetchedSubscription } from "@bh/proxy-kit";
import type { Outbound } from "../../../infra/outbound/outbound.js";
import type { SecretCipher } from "../../secrets/secret-cipher.js";

/**
 * Загрузка подписки (docs/35-stage4-plan.md Р101): запрос идёт через единый
 * клиент исходящих с сервисом `proxy.subscription` — по умолчанию только
 * напрямую, чужим прокси секретный адрес не уходит, а в журнале путь всегда
 * `/***`. Защита от SSRF — две ступени: `checkSubscriptionUrl` внутри
 * `fetchSubscription` (схема, логин, закрытый адрес и имя без точки) и
 * проверка DNS здесь перед каждым запросом и каждым переходом.
 *
 * Подмену ответа DNS между проверкой и запросом не ловим: подписку задаёт
 * владелец панели (решение тимлида от 13.10.2026).
 */

/** Адреса имени. Подмена в тестах; в приложении — `dns.lookup`. */
export type HostResolver = (host: string) => Promise<readonly string[]>;

export const HOST_RESOLVER = Symbol("HOST_RESOLVER");

export const systemResolver: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** `User-Agent`, под которым поставщики подписок отдают список ссылок. */
export const SUBSCRIPTION_USER_AGENT = "v2rayN/7.0";

/**
 * Идентификатор устройства (`x-hwid`) для поставщиков с ограничением числа
 * устройств. Постоянный: выводится из ключа подписки и ключа шифрования, а не
 * бросается на каждый запрос — иначе каждое обновление занимало бы у поставщика
 * новое «устройство» и упиралось в лимит. Не зависит от адреса: смена адреса у
 * того же поставщика устройство не меняет. Ключ шифрования по идентификатору не
 * восстановить (HMAC); он уходит поставщику, поэтому ничего секретного в нём нет.
 */
export const subscriptionHwid = (cipher: SecretCipher, subscriptionKey: string): string => cipher.deriveId("proxy.subscription.hwid", subscriptionKey);

/** Бросает, если имя не резолвится или хотя бы один его адрес не публичный. */
async function assertPublicHost(target: URL, resolve: HostResolver): Promise<void> {
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) throw new Error("закрытый адрес");
    return;
  }
  const addresses = await resolve(host);
  if (addresses.length === 0 || !addresses.every((address) => isPublicAddress(address))) throw new Error("имя указывает на закрытый адрес");
}

export function loadSubscription(outbound: Pick<Outbound, "forService">, resolve: HostResolver, url: string, hwid: string): Promise<FetchedSubscription> {
  return fetchSubscription(url, {
    fetch: outbound.forService("proxy.subscription"),
    assertAllowed: (target) => assertPublicHost(target, resolve),
    userAgent: SUBSCRIPTION_USER_AGENT,
    hwid,
  });
}
