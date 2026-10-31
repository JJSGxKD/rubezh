import { Logger } from "@nestjs/common";
import { socksDispatcher } from "fetch-socks";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import type { OutboundProxy, ProxyFetch } from "./outbound-route.js";

/**
 * Соединение через прокси (docs/35-stage4-plan.md Р91, tasks/T-0065):
 * `http` и `https` — `ProxyAgent` с логином в заголовке Basic, `socks5` —
 * SOCKS-соединение из `fetch-socks` поверх `undici`.
 *
 * Диспетчер дорогой (пул соединений), поэтому кэш по id прокси и моменту
 * правки: правка в панели собирает новый, прежний закрывается после
 * завершения запросов, которые на нём уже идут. Пароль живёт только внутри
 * диспетчера и нигде не логируется.
 */

const logger = new Logger("outbound");
const cache = new Map<string, { stamp: number; dispatcher: Dispatcher }>();

function build(proxy: OutboundProxy): Dispatcher {
  if (proxy.scheme === "socks5") {
    const login = proxy.username === null ? {} : { userId: proxy.username, password: proxy.password ?? "" };
    return socksDispatcher({ type: 5, host: proxy.host, port: proxy.port, ...login });
  }
  // IPv6 в адресе прокси — в скобках, иначе порт не отделить.
  const host = proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host;
  const token = proxy.username === null ? {} : { token: `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ""}`, "utf8").toString("base64")}` };
  return new ProxyAgent({ uri: `${proxy.scheme}://${host}:${String(proxy.port)}`, ...token });
}

/** Диспетчер прокси; тот же, пока прокси не правили. */
export function dispatcherFor(proxy: OutboundProxy): Dispatcher {
  const cached = cache.get(proxy.id);
  if (cached !== undefined && cached.stamp === proxy.updatedAt) return cached.dispatcher;
  const dispatcher = build(proxy);
  cache.set(proxy.id, { stamp: proxy.updatedAt, dispatcher });
  if (cached !== undefined) {
    cached.dispatcher.close().catch((error: unknown) => {
      logger.warn(JSON.stringify({ module: "outbound", event: "proxy_dispatcher_close_failed", proxyId: proxy.id, reason: error instanceof Error ? error.name : "unknown" }));
    });
  }
  return dispatcher;
}

type UndiciInput = Parameters<typeof undiciFetch>[0];
type UndiciInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

/**
 * `fetch` через прокси. Идёт через `fetch` самого `undici`, а не глобальный:
 * диспетчер из пакета с глобальным `fetch` Node другой версии не дружит.
 * Типы запроса и ответа у двух `fetch` одинаковы по форме, но разные по
 * объявлению — отсюда приведение в одном месте.
 */
export const undiciProxyFetch: ProxyFetch = async (proxy, input, init) => {
  const response = await undiciFetch(input as UndiciInput, { ...init, dispatcher: dispatcherFor(proxy) } as UndiciInit);
  return response as unknown as Response;
};
