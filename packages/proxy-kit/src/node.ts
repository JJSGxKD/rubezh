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
  /** xhttp: дополнительные настройки (`xhttpSettings.extra`) как есть; предел и глубину задаёт `jsonObjectOf` */
  extra?: Record<string, unknown>;
  /** tcp: объект `header` Xray с HTTP-маскировкой (`type: "http"`) как есть */
  rawHeader?: Record<string, unknown>;
}

/**
 * Старые поля закрепления сертификата: Xray 26.11 их ещё принимает, поэтому они
 * переходят в конфиг без изменений. Только эти три поля и только списки строк:
 * больше в `tlsSettings` из этого места не попадёт ничего.
 */
export interface LegacyPinning {
  pinnedPeerCertificateChainSha256?: string[];
  pinnedPeerCertificatePublicKeySha256?: string[];
  verifyPeerCertInNames?: string[];
}

export type NodeSecurity =
  | { kind: "none" }
  | {
      kind: "tls";
      serverName: string;
      alpn: string[];
      fingerprint: string | null;
      /** ECH: список конфигов или `домен+https://адрес-DoH` (`echConfigList`) */
      ech?: string;
      echForceQuery?: "none" | "half" | "full";
      /** sha256 сертификата сервера, 64 hex; несколько через запятую (`pinnedPeerCertSha256`) */
      pinnedPeerCertSha256?: string;
      verifyPeerCertByName?: string;
      legacyPinning?: LegacyPinning;
    }
  | {
      kind: "reality";
      serverName: string;
      fingerprint: string;
      publicKey: string;
      shortId: string;
      spiderX: string;
      /** публичный ключ постквантовой подписи ML-DSA-65, base64url (`mldsa65Verify`) */
      mldsa65Verify?: string;
    };

/**
 * Служебный выход `freedom` рядом с узлом: фрагментация и шум первых пакетов.
 * В конфиге спутника узел идёт через него (`sockopt.dialerProxy`).
 */
export interface NodeDialer {
  /** `settings` выхода `freedom` как есть, без `redirect` */
  settings: Record<string, unknown>;
}

export interface ProxyNode {
  /** 16 hex от sha256(протокол|host|port|secret|транспорт|безопасность|…): название на ключ не влияет */
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
  /** vmess `scy`, shadowsocks method; у vless — строка шифрования VLESS (`encryption`), `null` — без шифрования */
  cipher: string | null;
  transport: NodeTransport;
  security: NodeSecurity;
  dialer?: NodeDialer;
}

/**
 * Почему ссылка пропущена. Подробность (`detail`) — имя параметра или схема,
 * но никогда не кусок ссылки: в ссылке секреты.
 */
export type SkipReason = "unsupported_scheme" | "unsupported_transport" | "unsupported_option" | "unsupported_cipher" | "malformed";

export type ShareLinkResult = { ok: true; node: ProxyNode } | { ok: false; reason: SkipReason; detail: string };
