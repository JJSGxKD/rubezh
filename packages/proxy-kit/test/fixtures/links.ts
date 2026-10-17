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

export { b64, b64url };
