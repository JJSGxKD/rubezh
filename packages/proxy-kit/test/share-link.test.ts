import { describe, expect, it } from "vitest";
import { parseShareLink } from "../src/share-link.js";
import type { ProxyNode } from "../src/node.js";
import * as L from "./fixtures/links.js";

// Разбор ссылок узлов (vless, vmess, trojan, ss): ссылка — граница системы, а
// не доверенный ввод. Что не умеем, пропускается с причиной; секрет ссылки
// в причину не попадает.

function node(link: string): ProxyNode {
  const result = parseShareLink(link);
  if (!result.ok) throw new Error(`ссылка не разобралась: ${result.reason} ${result.detail}`);
  return result.node;
}

describe("vless", () => {
  it("reality поверх tcp: flow, отпечаток, ключ, shortId, spiderX; имя — с флагом, страна — по нему", () => {
    expect(node(L.VLESS_REALITY)).toMatchObject({
      protocol: "vless",
      name: "🇩🇪 Berlin",
      country: "DE",
      host: "203.0.113.10",
      port: 443,
      secret: L.UUID,
      flow: "xtls-rprx-vision",
      cipher: null,
      transport: { network: "tcp" },
      security: { kind: "reality", serverName: "www.example.com", fingerprint: "chrome", publicKey: "PUBLICKEY1", shortId: "ab12", spiderX: "/" },
    });
  });

  it("ws + tls: путь, хост, SNI, ALPN списком, отпечаток", () => {
    expect(node(L.VLESS_WS_TLS)).toMatchObject({
      name: "WS node",
      country: null,
      flow: null,
      transport: { network: "ws", path: "/ws", host: "cdn.example.com" },
      security: { kind: "tls", serverName: "cdn.example.com", alpn: ["h2", "http/1.1"], fingerprint: "firefox" },
    });
  });

  it("grpc: имя сервиса и режим", () => {
    expect(node(L.VLESS_GRPC).transport).toEqual({ network: "grpc", serviceName: "svc", mode: "multi" });
  });

  it("xhttp и httpupgrade", () => {
    expect(node(L.VLESS_XHTTP).transport).toEqual({ network: "xhttp", path: "/x", host: "h.example.com", mode: "auto" });
    expect(node(L.VLESS_HTTPUPGRADE).transport).toEqual({ network: "httpupgrade", path: "/up", host: "up.example.com" });
    expect(node(L.VLESS_HTTPUPGRADE).security).toEqual({ kind: "none" });
  });

  it("IPv6-хост в скобках — без скобок в узле", () => {
    expect(node(L.VLESS_IPV6)).toMatchObject({ host: "2001:db8::10", port: 443 });
  });

  it("умолчания: type=tcp, security=none, SNI — хост, отпечаток reality — chrome", () => {
    const plain = node(`vless://${L.UUID}@example.com:443`);
    expect(plain.transport).toEqual({ network: "tcp" });
    expect(plain.security).toEqual({ kind: "none" });

    const tls = node(`vless://${L.UUID}@example.com:443?security=tls`);
    expect(tls.security).toMatchObject({ kind: "tls", serverName: "example.com" });

    const reality = node(`vless://${L.UUID}@example.com:443?security=reality&pbk=K`);
    expect(reality.security).toMatchObject({ kind: "reality", fingerprint: "chrome", shortId: "", spiderX: "" });
  });

  it("повтор параметра — берётся первый; имя без названия — host:port", () => {
    expect(node(`vless://${L.UUID}@example.com:443?type=ws&type=grpc`).transport.network).toBe("ws");
    expect(node(`vless://${L.UUID}@example.com:443`).name).toBe("example.com:443");
  });

  it("имя режется до 80 знаков, управляющие символы убираются; битая процентная кодировка — как есть", () => {
    const long = node(`vless://${L.UUID}@example.com:443#${"a".repeat(200)}`);
    expect(long.name).toHaveLength(80);
    expect(node(`vless://${L.UUID}@example.com:443#a%00b%0Ac`).name).toBe("abc");
    expect(node(`vless://${L.UUID}@example.com:443#100%`).name).toBe("100%");
  });
});

describe("vmess", () => {
  it("base64-JSON: порт строкой, ws, tls", () => {
    expect(node(L.VMESS_BASE64)).toMatchObject({
      protocol: "vmess",
      name: "VM node",
      host: "example.com",
      port: 443,
      secret: L.UUID,
      cipher: "auto",
      flow: null,
      transport: { network: "ws", path: "/vm", host: "cdn.example.com" },
      security: { kind: "tls", serverName: "cdn.example.com", alpn: ["h2"], fingerprint: "chrome" },
    });
  });

  it("grpc в JSON: path — это serviceName, type — режим", () => {
    expect(node(L.VMESS_GRPC_BASE64).transport).toEqual({ network: "grpc", serviceName: "svc", mode: "multi" });
  });

  it("адресная форма vmess://uuid@host:port?…", () => {
    expect(node(L.VMESS_ADDRESS)).toMatchObject({
      protocol: "vmess",
      name: "VM addr",
      cipher: "aes-128-gcm",
      transport: { network: "ws", path: "/vm", host: "cdn.example.com" },
      security: { kind: "tls", serverName: "cdn.example.com" },
    });
  });

  it("порт числом, aid=0 числом, SNI из host при пустом sni", () => {
    const body = { v: "2", ps: "x", add: "example.com", port: 8443, id: L.UUID, aid: 0, net: "tcp", tls: "tls", host: "front.example.com" };
    const parsed = node(`vmess://${L.b64(JSON.stringify(body))}`);
    expect(parsed.port).toBe(8443);
    expect(parsed.cipher).toBe("auto");
    expect(parsed.security).toMatchObject({ kind: "tls", serverName: "front.example.com" });
  });

  it("мусор вместо base64-JSON — malformed", () => {
    for (const link of ["vmess://", "vmess://not-base64!!", `vmess://${L.b64("not json")}`, `vmess://${L.b64(JSON.stringify({ add: "example.com" }))}`]) {
      const result = parseShareLink(link);
      expect(result.ok, link).toBe(false);
      if (!result.ok) expect(result.reason, link).toBe("malformed");
    }
  });
});

describe("trojan", () => {
  it("пароль с процентной кодировкой, grpc, tls", () => {
    expect(node(L.TROJAN_GRPC)).toMatchObject({
      protocol: "trojan",
      name: "Trojan gRPC",
      secret: "p@ss",
      flow: null,
      transport: { network: "grpc", serviceName: "g" },
      security: { kind: "tls", serverName: "example.com" },
    });
  });

  it("security по умолчанию — tls; пустой пароль — malformed", () => {
    expect(node("trojan://pw@example.com:443").security).toMatchObject({ kind: "tls" });
    const result = parseShareLink("trojan://@example.com:443");
    expect(result.ok).toBe(false);
  });
});

describe("shadowsocks", () => {
  it("SIP002: userinfo в base64url", () => {
    expect(node(L.SS_SIP002)).toMatchObject({ protocol: "shadowsocks", name: "SS node", host: "example.com", port: 8388, secret: "secret", cipher: "aes-256-gcm", transport: { network: "tcp" }, security: { kind: "none" } });
  });

  it("2022-шифры: метод и пароль в процентной кодировке", () => {
    expect(node(L.SS_2022)).toMatchObject({ cipher: "2022-blake3-aes-128-gcm", secret: "cGFzc3dvcmQxMjM0NTY3OA==" });
  });

  it("старая форма: base64 от метод:пароль@хост:порт; ietf-имя приводится к имени Xray", () => {
    expect(node(L.SS_LEGACY)).toMatchObject({ name: "SS old", host: "example.com", port: 8388, secret: "pw", cipher: "chacha20-poly1305" });
  });

  it("xchacha20-ietf-poly1305 приводится к xchacha20-poly1305", () => {
    const link = `ss://${L.b64url("xchacha20-ietf-poly1305:pw")}@example.com:8388`;
    expect(node(link).cipher).toBe("xchacha20-poly1305");
  });
});

describe("ключ узла", () => {
  it("название на ключ не влияет, секрет, порт и транспорт — влияют", () => {
    const renamed = L.VLESS_WS_TLS.replace("#WS%20node", "#Another");
    expect(node(renamed).key).toBe(node(L.VLESS_WS_TLS).key);
    expect(node(renamed).key).toMatch(/^[0-9a-f]{16}$/);

    expect(node(L.VLESS_WS_TLS.replace("11111111", "22222222")).key).not.toBe(node(L.VLESS_WS_TLS).key);
    expect(node(L.VLESS_WS_TLS.replace(":443", ":8443")).key).not.toBe(node(L.VLESS_WS_TLS).key);
    expect(node(L.VLESS_WS_TLS.replace("path=%2Fws", "path=%2Fother")).key).not.toBe(node(L.VLESS_WS_TLS).key);
  });
});

describe("отказы", () => {
  function reason(link: string): { reason: string; detail: string } {
    const result = parseShareLink(link);
    if (result.ok) throw new Error(`ожидался отказ: ${link}`);
    return { reason: result.reason, detail: result.detail };
  }

  it("malformed: vless без UUID, плохой порт, reality без ключа", () => {
    expect(reason("vless://not-a-uuid@example.com:443").reason).toBe("malformed");
    expect(reason(`vless://${L.UUID}@example.com:0`).reason).toBe("malformed");
    expect(reason(`vless://${L.UUID}@example.com:70000`).reason).toBe("malformed");
    expect(reason(`vless://${L.UUID}@example.com`).reason).toBe("malformed");
    expect(reason(`vless://${L.UUID}@example.com:443?security=reality`).reason).toBe("malformed");
  });

  it("транспорты, которых нет в списке, — unsupported_transport", () => {
    for (const type of ["kcp", "http", "h2", "quic"]) {
      expect(reason(`vless://${L.UUID}@example.com:443?type=${type}`).reason, type).toBe("unsupported_transport");
    }
  });

  it("опции, которых не умеем, — unsupported_option с именем параметра", () => {
    const cases: [string, string][] = [
      [`vless://${L.UUID}@example.com:443?security=tls&allowInsecure=1`, "allowInsecure"],
      [`vless://${L.UUID}@example.com:443?security=tls&insecure=1`, "insecure"],
      [`vless://${L.UUID}@example.com:443?security=tls&pcs=abcdef`, "pcs"],
      [`vless://${L.UUID}@example.com:443?security=tls&vcn=example.com`, "vcn"],
      [`vless://${L.UUID}@example.com:443?security=tls&ech=abc`, "ech"],
      [`vless://${L.UUID}@example.com:443?security=tls&pqv=abc`, "pqv"],
      [`vless://${L.UUID}@example.com:443?encryption=mlkem768x25519plus.native.0rtt.KEY`, "encryption"],
      [`vless://${L.UUID}@example.com:443?type=tcp&headerType=http`, "headerType"],
      [`vless://${L.UUID}@example.com:443?flow=xtls-rprx-direct`, "flow"],
      [`ss://${L.b64url("aes-256-gcm:secret")}@example.com:8388?plugin=obfs-local%3Bobfs%3Dhttp`, "plugin"],
    ];
    for (const [link, name] of cases) {
      const failure = reason(link);
      expect(failure.reason, name).toBe("unsupported_option");
      expect(failure.detail, name).toBe(name);
    }
  });

  it("vmess: aid ≠ 0 — unsupported_option", () => {
    const body = { v: "2", ps: "x", add: "example.com", port: "443", id: L.UUID, aid: "64", net: "tcp" };
    const failure = reason(`vmess://${L.b64(JSON.stringify(body))}`);
    expect(failure).toEqual({ reason: "unsupported_option", detail: "aid" });
  });

  it("шифры вне списка Xray — unsupported_cipher", () => {
    const failure = reason(`ss://${L.b64url("rc4-md5:secret")}@example.com:8388`);
    expect(failure.reason).toBe("unsupported_cipher");
    const vmess = reason(`vmess://${L.UUID}@example.com:443?encryption=rc4`);
    expect(vmess.reason).toBe("unsupported_cipher");
  });

  it("схемы не из списка — unsupported_scheme с именем схемы", () => {
    for (const scheme of ["hysteria2", "hy2", "tuic", "wireguard", "socks", "ssr", "http"]) {
      expect(reason(`${scheme}://secret@example.com:443`), scheme).toEqual({ reason: "unsupported_scheme", detail: scheme });
    }
  });

  it("не ссылка вовсе — malformed", () => {
    expect(reason("просто текст").reason).toBe("malformed");
    expect(reason("").reason).toBe("malformed");
  });

  it("в причине отказа нет ни UUID, ни пароля, ни хоста, ни пути", () => {
    const links = [
      `vless://${L.UUID}@secret-host.example.com:443?security=tls&allowInsecure=1&path=%2Fsecret-path`,
      `ss://${L.b64url("rc4-md5:topsecret")}@secret-host.example.com:8388`,
      `trojan://topsecret@secret-host.example.com:70000`,
      `hysteria2://topsecret@secret-host.example.com:443/?obfs-password=topsecret`,
    ];
    for (const link of links) {
      const text = JSON.stringify(parseShareLink(link));
      for (const secret of [L.UUID, "topsecret", "secret-host", "secret-path"]) expect(text, `${secret} в ${link}`).not.toContain(secret);
    }
  });
});
