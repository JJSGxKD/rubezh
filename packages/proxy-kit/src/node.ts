/**
 * Узел подписки в общем виде: не зависит от протокола ссылки. Поля — то, что
 * нужно собрать исходящее подключение Xray, и ничего лишнего.
 */
export type NodeProtocol = "vless" | "vmess" | "trojan" | "shadowsocks";
export type NodeNetwork = "tcp" | "ws" | "grpc" | "httpupgrade" | "xhttp";

export interface NodeTransport {
  network: NodeNetwork;
  path?: string;
  host?: string;
  serviceName?: string;
  mode?: string;
}

export type NodeSecurity =
  | { kind: "none" }
  | { kind: "tls"; serverName: string; alpn: string[]; fingerprint: string | null }
  | { kind: "reality"; serverName: string; fingerprint: string; publicKey: string; shortId: string; spiderX: string };

export interface ProxyNode {
  /** 16 hex от sha256(протокол|host|port|secret|транспорт|безопасность): название на ключ не влияет */
  key: string;
  protocol: NodeProtocol;
  name: string;
  country: string | null;
  host: string;
  port: number;
  /** uuid у vless/vmess, пароль у trojan/shadowsocks */
  secret: string;
  /** vless */
  flow: string | null;
  /** vmess `scy`, shadowsocks method */
  cipher: string | null;
  transport: NodeTransport;
  security: NodeSecurity;
}

/**
 * Почему ссылка пропущена. Подробность (`detail`) — имя параметра или схема,
 * но никогда не кусок ссылки: в ссылке секреты.
 */
export type SkipReason = "unsupported_scheme" | "unsupported_transport" | "unsupported_option" | "unsupported_cipher" | "malformed";

export type ShareLinkResult = { ok: true; node: ProxyNode } | { ok: false; reason: SkipReason; detail: string };
