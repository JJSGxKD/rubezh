// Выдуманные ссылки узлов: ни одного настоящего ключа, адреса из блока
// документации (203.0.113.0/24) и example.com.

export const UUID = "11111111-1111-4111-8111-111111111111";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const b64url = (text: string): string => b64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** vless + reality + tcp, flow vision; имя — флаг Германии и город. */
export const VLESS_REALITY =
  `vless://${UUID}@203.0.113.10:443?type=tcp&security=reality&sni=www.example.com&fp=chrome&pbk=PUBLICKEY1&sid=ab12&spx=%2F&flow=xtls-rprx-vision#%F0%9F%87%A9%F0%9F%87%AA%20Berlin`;

/** vless + ws + tls с ALPN. */
export const VLESS_WS_TLS =
  `vless://${UUID}@example.com:443?type=ws&security=tls&sni=cdn.example.com&alpn=h2%2Chttp%2F1.1&fp=firefox&path=%2Fws&host=cdn.example.com#WS%20node`;

/** vless + grpc + tls. */
export const VLESS_GRPC =
  `vless://${UUID}@example.com:443?type=grpc&security=tls&sni=example.com&serviceName=svc&mode=multi#gRPC`;

/** vless + xhttp + reality. */
export const VLESS_XHTTP =
  `vless://${UUID}@203.0.113.11:443?type=xhttp&security=reality&sni=www.example.com&pbk=PUBLICKEY2&sid=cd34&path=%2Fx&host=h.example.com&mode=auto#XHTTP`;

/** vless + httpupgrade без шифрования. */
export const VLESS_HTTPUPGRADE = `vless://${UUID}@example.com:80?type=httpupgrade&path=%2Fup&host=up.example.com#Upgrade`;

/** vless, IPv6-хост в скобках. */
export const VLESS_IPV6 = `vless://${UUID}@[2001:db8::10]:443?type=tcp&security=none#v6`;

const VMESS_JSON = {
  v: "2",
  ps: "VM node",
  add: "example.com",
  port: "443",
  id: UUID,
  aid: "0",
  scy: "auto",
  net: "ws",
  type: "none",
  host: "cdn.example.com",
  path: "/vm",
  tls: "tls",
  sni: "cdn.example.com",
  alpn: "h2",
  fp: "chrome",
};

export const VMESS_BASE64 = `vmess://${b64(JSON.stringify(VMESS_JSON))}`;

export const VMESS_GRPC_BASE64 = `vmess://${b64(JSON.stringify({ ...VMESS_JSON, ps: "VM grpc", net: "grpc", path: "svc", type: "multi", host: "" }))}`;

export const VMESS_ADDRESS =
  `vmess://${UUID}@example.com:443?type=ws&security=tls&sni=cdn.example.com&path=%2Fvm&host=cdn.example.com&encryption=aes-128-gcm#VM%20addr`;

export const TROJAN_GRPC = `trojan://p%40ss@example.com:443?security=tls&sni=example.com&type=grpc&serviceName=g#Trojan%20gRPC`;

/** Shadowsocks SIP002: userinfo — base64url от `метод:пароль`. */
export const SS_SIP002 = `ss://${b64url("aes-256-gcm:secret")}@example.com:8388#SS%20node`;

/** Shadowsocks 2022: `метод:пароль` в процентной кодировке, пароль — base64-ключ. */
export const SS_2022 = `ss://2022-blake3-aes-128-gcm:cGFzc3dvcmQxMjM0NTY3OA%3D%3D@example.com:8388#SS%202022`;

/** Старая форма: base64 от всей `метод:пароль@хост:порт`. */
export const SS_LEGACY = `ss://${b64("chacha20-ietf-poly1305:pw@example.com:8388")}#SS%20old`;

// Способы подключения, которые выдают поставщики (docs/35-stage4-plan.md Р192, tasks/T-0387).
// Значения, чью форму проверяет ядро Xray (ключи, ECH, постквантовая подпись, шифрование
// VLESS), — заглушки: `infra/prod/xray/check-config.sh` подставляет настоящую форму.

const enc = encodeURIComponent;

/** sha256 сертификата, 64 hex. */
export const PIN_HEX = "0123456789abcdef".repeat(4);
export const ECH_CONFIG = "ECHCONFIG1";
export const MLDSA65_VERIFY = "MLDSA65VERIFY1";
export const VLESS_ENCRYPTION_VALUE = "mlkem768x25519plus.native.0rtt.VLESSENCKEY1";
/** Дополнительные настройки XHTTP из ссылки. */
export const XHTTP_EXTRA = { xPaddingBytes: "100-1000", xmux: { maxConcurrency: "16-32" } };

/** vless + xhttp + reality с `extra`. */
export const VLESS_XHTTP_EXTRA =
  `vless://${UUID}@203.0.113.11:443?type=xhttp&security=reality&sni=www.example.com&pbk=PUBLICKEY2&sid=cd34&path=%2Fx&host=h.example.com&mode=auto&extra=${enc(JSON.stringify(XHTTP_EXTRA))}#XHTTP%20extra`;

/** vless + tcp + tls с ECH. */
export const VLESS_TLS_ECH = `vless://${UUID}@example.com:443?type=tcp&security=tls&sni=example.com&ech=${ECH_CONFIG}#ECH`;

/** vless + tcp + tls с закреплённым сертификатом и проверкой по имени. */
export const VLESS_TLS_PINNED = `vless://${UUID}@example.com:443?type=tcp&security=tls&sni=example.com&pcs=${PIN_HEX}&vcn=example.com#Pinned`;

/** vless + reality + постквантовая проверка. */
export const VLESS_REALITY_PQV =
  `vless://${UUID}@203.0.113.10:443?type=tcp&security=reality&sni=www.example.com&fp=chrome&pbk=PUBLICKEY1&sid=ab12&pqv=${MLDSA65_VERIFY}&flow=xtls-rprx-vision#PQV`;

/** vless с шифрованием самого VLESS, без TLS. */
export const VLESS_ENCRYPTION = `vless://${UUID}@203.0.113.13:443?type=tcp&security=none&encryption=${enc(VLESS_ENCRYPTION_VALUE)}#Enc`;

/** vless + reality + flow с UDP 443. */
export const VLESS_VISION_UDP443 =
  `vless://${UUID}@203.0.113.10:443?type=tcp&security=reality&sni=www.example.com&fp=chrome&pbk=PUBLICKEY1&sid=ab12&flow=xtls-rprx-vision-udp443#Vision%20udp`;

/** vmess + RAW с HTTP-маскировкой. */
export const VMESS_RAW_HTTP = `vmess://${UUID}@203.0.113.12:80?type=tcp&headerType=http&host=a.example.com%2Cb.example.com&path=%2Fx&encryption=auto#VM%20raw`;

/** Заголовок RAW, который из этой ссылки должен получиться. */
export const RAW_HTTP_HEADER = { type: "http", request: { path: ["/x"], headers: { Host: ["a.example.com", "b.example.com"] } } };

export { b64, b64url };
