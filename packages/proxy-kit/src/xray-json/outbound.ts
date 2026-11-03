import { z } from "zod";
import { bareHost, cleanLabel, parsePort } from "../internal/text.js";
import { fail, finishNode, UUID, type Fail } from "../links/common.js";
import { SHADOWSOCKS_METHODS } from "../links/shadowsocks.js";
import { VMESS_CIPHERS } from "../links/vmess.js";
import type { NodeProtocol, ShareLinkResult } from "../node.js";
import { streamFromSettings } from "./stream.js";

/**
 * Один выход Xray (`outbounds[]` конфига) в `ProxyNode` — тот же узел, что даёт
 * разбор ссылки, и с теми же отказами. Соответствие полей — обратное к
 * `xray-config.ts`: `settings.vnext[].users[]` у vless и vmess,
 * `settings.servers[]` у trojan и shadowsocks. Не бросает: выход — вход из сети.
 */

const PROTOCOLS: ReadonlySet<string> = new Set<NodeProtocol>(["vless", "vmess", "trojan", "shadowsocks"]);

const isNodeProtocol = (value: string): value is NodeProtocol => PROTOCOLS.has(value);

const envelope = z.object({ settings: z.unknown().optional(), streamSettings: z.unknown().optional(), proxySettings: z.unknown().optional() });
const record = z.record(z.string(), z.unknown());
const endpoint = z.object({ address: z.string().optional(), port: z.union([z.number(), z.string()]).optional() });
const vlessUser = z.object({ id: z.string().optional(), encryption: z.string().optional(), flow: z.string().optional() });
const vmessUser = z.object({ id: z.string().optional(), alterId: z.union([z.number(), z.string()]).optional(), security: z.string().optional() });
const serverEntry = z.object({ password: z.string().optional(), method: z.string().optional() });

/** Что уже известно об узле, когда разобрана часть выхода с адресом и учётными данными. */
interface Endpoint {
  host: string;
  port: number;
  secret: string;
  flow: string | null;
  cipher: string | null;
}

type Step<T> = ({ ok: true } & T) | Fail;

/**
 * `protocol` — уже в нижнем регистре; `remarks` — название конфига, под которым
 * узел виден в панели.
 */
export function parseOutbound(protocol: string, raw: unknown, remarks: string): ShareLinkResult {
  try {
    return convert(protocol, raw, remarks);
  } catch {
    // Разбор не должен падать, но если упал — это «выход непонятен», а не авария.
    return fail("malformed", protocol);
  }
}

function convert(protocol: string, raw: unknown, remarks: string): ShareLinkResult {
  if (!isNodeProtocol(protocol)) return fail("unsupported_scheme", protocol);
  const outbound = envelope.safeParse(raw);
  if (!outbound.success) return fail("malformed", protocol);
  // Цепочка через другой выход: без него узел пойдёт напрямую, а это другой маршрут.
  if (outbound.data.proxySettings !== undefined && outbound.data.proxySettings !== null) return fail("unsupported_option", "proxySettings");

  const found = protocol === "vless" || protocol === "vmess" ? vnextEndpoint(protocol, outbound.data.settings) : serversEndpoint(protocol, outbound.data.settings);
  if (!found.ok) return found;
  const stream = streamFromSettings(outbound.data.streamSettings, found.host);
  if (!stream.ok) return stream;

  const { host, port } = found;
  return {
    ok: true,
    node: finishNode({
      protocol,
      name: cleanLabel(remarks, `${host}:${String(port)}`),
      host,
      port,
      secret: found.secret,
      flow: found.flow,
      cipher: found.cipher,
      transport: stream.transport,
      security: stream.security,
    }),
  };
}

/** vless и vmess: `settings.vnext[0]` и его единственный пользователь. */
function vnextEndpoint(protocol: "vless" | "vmess", settings: unknown): Step<Endpoint> {
  const vnext = listOf(settings, "vnext");
  if (!vnext.ok) return vnext;
  const server = single(vnext.list, "vnext");
  if (!server.ok) return server;
  const address = addressOf(server.item);
  if (!address.ok) return address;
  const users = listOf(server.item, "users");
  if (!users.ok) return users;
  const one = single(users.list, "users");
  if (!one.ok) return one;

  if (protocol === "vless") {
    const user = vlessUser.safeParse(one.item);
    if (!user.success) return fail("malformed", "users");
    const secret = uuidOf(user.data.id);
    if (secret === null) return fail("malformed", "uuid");
    // Шифрование VLESS в обычных подписках — `none`; постквантовое и прочее мы пропускаем.
    const encryption = user.data.encryption ?? "none";
    if (encryption !== "none" && encryption !== "") return fail("unsupported_option", "encryption");
    const flow = user.data.flow ?? "";
    if (flow !== "" && flow !== "xtls-rprx-vision") return fail("unsupported_option", "flow");
    return { ...address, ok: true, secret, flow: flow === "" ? null : flow, cipher: null };
  }

  const user = vmessUser.safeParse(one.item);
  if (!user.success) return fail("malformed", "users");
  const secret = uuidOf(user.data.id);
  if (secret === null) return fail("malformed", "uuid");
  const alterId = String(user.data.alterId ?? "0");
  if (alterId !== "0" && alterId !== "") return fail("unsupported_option", "aid");
  const cipher = user.data.security === undefined || user.data.security === "" ? "auto" : user.data.security;
  if (!VMESS_CIPHERS.has(cipher)) return fail("unsupported_cipher", "scy");
  return { ...address, ok: true, secret, flow: null, cipher };
}

/** trojan и shadowsocks: `settings.servers[0]`. */
function serversEndpoint(protocol: "trojan" | "shadowsocks", settings: unknown): Step<Endpoint> {
  const servers = listOf(settings, "servers");
  if (!servers.ok) return servers;
  const one = single(servers.list, "servers");
  if (!one.ok) return one;
  const address = addressOf(one.item);
  if (!address.ok) return address;
  const server = serverEntry.safeParse(one.item);
  if (!server.success) return fail("malformed", "servers");

  const secret = server.data.password ?? "";
  if (secret === "") return fail("malformed", "password");
  if (protocol === "trojan") return { ...address, ok: true, secret, flow: null, cipher: null };

  const method = server.data.method ?? "";
  if (method === "") return fail("malformed", "method");
  const cipher = SHADOWSOCKS_METHODS.get(method.toLowerCase());
  if (cipher === undefined) return fail("unsupported_cipher", "method");
  return { ...address, ok: true, secret, flow: null, cipher };
}

/** Адрес и порт записи `vnext` или `servers`. */
function addressOf(entry: unknown): Step<{ host: string; port: number }> {
  const parsed = endpoint.safeParse(entry);
  if (!parsed.success) return fail("malformed", "settings");
  const host = bareHost((parsed.data.address ?? "").trim());
  if (host === "") return fail("malformed", "address");
  const port = parsePort(String(parsed.data.port ?? ""));
  return port === null ? fail("malformed", "port") : { ok: true, host, port };
}

/** Список `field` из объекта настроек. */
function listOf(settings: unknown, field: string): Step<{ list: unknown[] }> {
  const parsed = record.safeParse(settings);
  if (!parsed.success) return fail("malformed", "settings");
  const list = parsed.data[field];
  return Array.isArray(list) ? { ok: true, list } : fail("malformed", field);
}

/** Единственный элемент списка: пустой — ошибка данных, несколько — то, чего мы не умеем. */
function single(list: readonly unknown[], name: string): Step<{ item: unknown }> {
  if (list.length === 0) return fail("malformed", name);
  if (list.length > 1) return fail("unsupported_option", name);
  return { ok: true, item: list[0] };
}

const uuidOf = (id: string | undefined): string | null => (id !== undefined && UUID.test(id) ? id.toLowerCase() : null);
