// Выходы Xray, равные по смыслу ссылкам из `links.ts`: узел из JSON-подписки и
// узел из ссылки обязаны дать один и тот же исходящий конфиг. Адреса — из блока
// документации и example.com, ключи выдуманные.

import * as L from "./links.js";

export type Json = Record<string, unknown>;

const user = (extra: Json = {}): Json => ({ id: L.UUID, encryption: "none", ...extra });
const vnext = (address: string, port: number, users: Json[]): Json => ({ vnext: [{ address, port, users }] });

export const OUT_VLESS_REALITY: Json = {
  tag: "proxy",
  protocol: "vless",
  settings: vnext("203.0.113.10", 443, [user({ flow: "xtls-rprx-vision" })]),
  streamSettings: {
    network: "tcp",
    security: "reality",
    realitySettings: { serverName: "www.example.com", fingerprint: "chrome", publicKey: "PUBLICKEY1", shortId: "ab12", spiderX: "/" },
  },
  mux: { enabled: false },
};

/** Плоская форма настроек VLESS (Xray 25+): без `vnext`, адрес и пользователь в самих `settings`. */
export const OUT_VLESS_REALITY_FLAT: Json = {
  ...OUT_VLESS_REALITY,
  settings: { address: "203.0.113.10", port: 443, id: L.UUID, encryption: "none", flow: "xtls-rprx-vision", level: 8 },
};

export const OUT_VLESS_WS_TLS: Json = {
  tag: "proxy",
  protocol: "vless",
  settings: vnext("example.com", 443, [user()]),
  streamSettings: {
    network: "ws",
    security: "tls",
    tlsSettings: { serverName: "cdn.example.com", alpn: ["h2", "http/1.1"], fingerprint: "firefox", allowInsecure: false },
    wsSettings: { path: "/ws", headers: { Host: "cdn.example.com" } },
  },
};

/** Та же ws+tls, но в плоской форме. */
export const OUT_VLESS_WS_TLS_FLAT: Json = { ...OUT_VLESS_WS_TLS, settings: { address: "example.com", port: "443", id: L.UUID, encryption: "none" } };

export const OUT_VLESS_GRPC: Json = {
  tag: "proxy",
  protocol: "vless",
  settings: vnext("example.com", 443, [user()]),
  streamSettings: {
    network: "grpc",
    security: "tls",
    tlsSettings: { serverName: "example.com" },
    grpcSettings: { serviceName: "svc", multiMode: true },
  },
};

export const OUT_VLESS_XHTTP: Json = {
  tag: "proxy",
  protocol: "vless",
  settings: vnext("203.0.113.11", 443, [user()]),
  streamSettings: {
    network: "xhttp",
    security: "reality",
    realitySettings: { serverName: "www.example.com", publicKey: "PUBLICKEY2", shortId: "cd34" },
    xhttpSettings: { path: "/x", host: "h.example.com", mode: "auto" },
  },
};

export const OUT_VLESS_HTTPUPGRADE: Json = {
  tag: "proxy",
  protocol: "vless",
  settings: vnext("example.com", 80, [user()]),
  streamSettings: { network: "httpupgrade", security: "none", httpupgradeSettings: { path: "/up", host: "up.example.com" } },
};

export const OUT_VLESS_IPV6: Json = {
  tag: "proxy",
  protocol: "vless",
  settings: vnext("2001:db8::10", 443, [user()]),
  streamSettings: { network: "tcp", security: "none" },
};

export const OUT_VMESS_WS_TLS: Json = {
  tag: "proxy",
  protocol: "vmess",
  settings: vnext("example.com", 443, [{ id: L.UUID, alterId: 0, security: "auto" }]),
  streamSettings: {
    network: "ws",
    security: "tls",
    tlsSettings: { serverName: "cdn.example.com", alpn: ["h2"], fingerprint: "chrome" },
    wsSettings: { path: "/vm", headers: { Host: "cdn.example.com" } },
  },
};

export const OUT_VMESS_ADDRESS: Json = {
  tag: "proxy",
  protocol: "vmess",
  settings: vnext("example.com", 443, [{ id: L.UUID, alterId: 0, security: "aes-128-gcm" }]),
  streamSettings: {
    network: "ws",
    security: "tls",
    tlsSettings: { serverName: "cdn.example.com" },
    wsSettings: { path: "/vm", headers: { Host: "cdn.example.com" } },
  },
};

export const OUT_TROJAN_GRPC: Json = {
  tag: "proxy",
  protocol: "trojan",
  settings: { servers: [{ address: "example.com", port: 443, password: "p@ss" }] },
  streamSettings: { network: "grpc", security: "tls", tlsSettings: { serverName: "example.com" }, grpcSettings: { serviceName: "g" } },
};

export const OUT_SS_SIP002: Json = {
  tag: "proxy",
  protocol: "shadowsocks",
  settings: { servers: [{ address: "example.com", port: 8388, method: "aes-256-gcm", password: "secret" }] },
};

export const OUT_SS_2022: Json = {
  tag: "proxy",
  protocol: "shadowsocks",
  settings: { servers: [{ address: "example.com", port: 8388, method: "2022-blake3-aes-128-gcm", password: "cGFzc3dvcmQxMjM0NTY3OA==" }] },
  streamSettings: { network: "tcp", security: "none" },
};

export const OUT_SS_LEGACY: Json = {
  tag: "proxy",
  protocol: "shadowsocks",
  settings: { servers: [{ address: "example.com", port: 8388, method: "chacha20-ietf-poly1305", password: "pw" }] },
};

/** Пары «ссылка — выход»: и то и другое описывает один и тот же узел. */
export const PAIRS: readonly [name: string, link: string, outbound: Json][] = [
  ["vless reality tcp", L.VLESS_REALITY, OUT_VLESS_REALITY],
  ["vless ws tls", L.VLESS_WS_TLS, OUT_VLESS_WS_TLS],
  ["vless reality tcp, плоская форма настроек (Xray 25+)", L.VLESS_REALITY, OUT_VLESS_REALITY_FLAT],
  ["vless ws tls, плоская форма настроек (Xray 25+)", L.VLESS_WS_TLS, OUT_VLESS_WS_TLS_FLAT],
  ["vless grpc tls", L.VLESS_GRPC, OUT_VLESS_GRPC],
  ["vless xhttp reality", L.VLESS_XHTTP, OUT_VLESS_XHTTP],
  ["vless httpupgrade", L.VLESS_HTTPUPGRADE, OUT_VLESS_HTTPUPGRADE],
  ["vless IPv6", L.VLESS_IPV6, OUT_VLESS_IPV6],
  ["vmess ws tls (JSON-форма ссылки)", L.VMESS_BASE64, OUT_VMESS_WS_TLS],
  ["vmess ws tls (адресная форма)", L.VMESS_ADDRESS, OUT_VMESS_ADDRESS],
  ["trojan grpc tls", L.TROJAN_GRPC, OUT_TROJAN_GRPC],
  ["shadowsocks SIP002", L.SS_SIP002, OUT_SS_SIP002],
  ["shadowsocks 2022", L.SS_2022, OUT_SS_2022],
  ["shadowsocks, старая форма", L.SS_LEGACY, OUT_SS_LEGACY],
];

/** Служебные выходы панели: не узлы и в пропуски не попадают. */
export const SERVICE_OUTBOUNDS: Json[] = [
  { tag: "direct", protocol: "freedom" },
  { tag: "block", protocol: "blackhole", settings: { response: { type: "http" } } },
  { tag: "dns-out", protocol: "dns" },
];

/** Конфиг клиента, как его отдаёт панель: шум вокруг выходов не мешает разбору. */
export function config(remarks: string | undefined, proxy: Json | Json[], extra: Json = {}): Json {
  return {
    ...(remarks === undefined ? {} : { remarks }),
    log: { loglevel: "warning" },
    dns: { servers: ["1.1.1.1"] },
    inbounds: [{ tag: "socks", port: 10808, listen: "127.0.0.1", protocol: "socks", settings: { udp: true } }],
    outbounds: [...(Array.isArray(proxy) ? proxy : [proxy]), ...SERVICE_OUTBOUNDS],
    routing: { domainStrategy: "IPIfNonMatch", rules: [{ type: "field", outboundTag: "direct", ip: ["geoip:private"] }] },
    ...extra,
  };
}

/** Копия выхода с правкой на верхнем уровне. */
export const patched = (outbound: Json, patch: Json): Json => ({ ...outbound, ...patch });

/** Копия выхода с заменой одного поля `streamSettings`. */
export function withStream(outbound: Json, patch: Json): Json {
  return { ...outbound, streamSettings: { ...(outbound["streamSettings"] as Json), ...patch } };
}
