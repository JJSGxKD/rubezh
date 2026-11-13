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
      [`vless://${L.UUID}@example.com:443?type=tcp&headerType=srtp`, "headerType"],
      [`vless://${L.UUID}@example.com:443?flow=xtls-rprx-direct`, "flow"],
      [`vless://${L.UUID}@example.com:443?flow=xtls-rprx-vision-splice`, "flow"],
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

describe("способы подключения поставщиков (Р192, T-0387)", () => {
  const BASE = `vless://${L.UUID}@203.0.113.11:443`;
  const failure = (link: string): { reason: string; detail: string } => {
    const result = parseShareLink(link);
    if (result.ok) throw new Error("ожидался отказ");
    return { reason: result.reason, detail: result.detail };
  };
  const reality = `${BASE}?type=xhttp&security=reality&sni=www.example.com&pbk=PUBLICKEY2&sid=cd34`;
  const tls = `${BASE}?type=tcp&security=tls&sni=example.com`;

  describe("extra у XHTTP", () => {
    it("объект из ссылки идёт в transport.extra как есть", () => {
      expect(node(L.VLESS_XHTTP_EXTRA).transport).toEqual({ network: "xhttp", path: "/x", host: "h.example.com", mode: "auto", extra: L.XHTTP_EXTRA });
    });

    it("не JSON, массив и не объект — malformed / extra", () => {
      for (const value of ["not-json", "[1]", "5", '"text"', "null"]) {
        expect(failure(`${reality}&extra=${encodeURIComponent(value)}`), value).toEqual({ reason: "malformed", detail: "extra" });
      }
    });

    it("длиннее 4096 знаков и глубже 8 уровней — malformed / extra", () => {
      const long = encodeURIComponent(JSON.stringify({ v: "x".repeat(5000) }));
      expect(failure(`${reality}&extra=${long}`)).toEqual({ reason: "malformed", detail: "extra" });

      let deep: unknown = { leaf: 1 };
      for (let level = 0; level < 9; level++) deep = { next: deep };
      expect(failure(`${reality}&extra=${encodeURIComponent(JSON.stringify(deep))}`)).toEqual({ reason: "malformed", detail: "extra" });

      let fine: unknown = { leaf: 1 };
      for (let level = 0; level < 6; level++) fine = { next: fine };
      expect(parseShareLink(`${reality}&extra=${encodeURIComponent(JSON.stringify(fine))}`).ok).toBe(true);
    });

    it("у другого транспорта extra игнорируется, как раньше", () => {
      const ws = node(`${BASE}?type=ws&security=none&extra=${encodeURIComponent('{"a":1}')}`);
      expect(ws.transport).toEqual({ network: "ws" });
    });

    it("без extra поля в транспорте нет", () => {
      expect(node(L.VLESS_XHTTP).transport).not.toHaveProperty("extra");
    });
  });

  describe("ECH, закреплённый сертификат, проверка по имени", () => {
    it("ech, pcs и vcn попадают в безопасность tls", () => {
      expect(node(`${tls}&ech=${L.ECH_CONFIG}&pcs=${L.PIN_HEX}&vcn=example.com`).security).toEqual({
        kind: "tls",
        serverName: "example.com",
        alpn: [],
        fingerprint: null,
        ech: L.ECH_CONFIG,
        pinnedPeerCertSha256: L.PIN_HEX,
        verifyPeerCertByName: "example.com",
      });
    });

    it("форма DoH для ECH: домен+адрес — со знаком плюс в процентной кодировке", () => {
      const value = "cloudflare-ech.com+https://1.1.1.1/dns-query";
      expect(node(`${tls}&ech=${encodeURIComponent(value)}`).security).toMatchObject({ ech: value });
    });

    it("ech с пробелом, управляющим знаком или длиннее 4096 — malformed / ech", () => {
      for (const value of ["a b", "a\u0007b", "а", "x".repeat(4097)]) {
        expect(failure(`${tls}&ech=${encodeURIComponent(value)}`), value).toEqual({ reason: "malformed", detail: "ech" });
      }
    });

    it("pcs не из 64-значных hex-отпечатков и vcn с пробелом — malformed", () => {
      for (const value of ["abcdef", "zz".repeat(32), `${L.PIN_HEX},`]) {
        expect(failure(`${tls}&pcs=${value}`), value).toEqual({ reason: "malformed", detail: "pcs" });
      }
      expect(failure(`${tls}&vcn=a%20b`)).toEqual({ reason: "malformed", detail: "vcn" });
    });

    it("несколько отпечатков через запятую проходят", () => {
      const two = `${L.PIN_HEX},${"ab".repeat(32)}`;
      expect(node(`${tls}&pcs=${two}`).security).toMatchObject({ pinnedPeerCertSha256: two });
    });

    it("у reality эти параметры в узел не попадают", () => {
      const withReality = node(`${reality}&ech=${L.ECH_CONFIG}&pcs=${L.PIN_HEX}&vcn=example.com`);
      expect(withReality.security).not.toHaveProperty("ech");
      expect(withReality.security).not.toHaveProperty("pinnedPeerCertSha256");
    });

    it("allowInsecure по-прежнему пропуск: проверку сертификата отключать нельзя", () => {
      expect(failure(`${tls}&allowInsecure=1&pcs=${L.PIN_HEX}`)).toEqual({ reason: "unsupported_option", detail: "allowInsecure" });
    });
  });

  describe("постквантовая проверка REALITY", () => {
    it("pqv — в mldsa65Verify", () => {
      expect(node(L.VLESS_REALITY_PQV).security).toMatchObject({ kind: "reality", mldsa65Verify: L.MLDSA65_VERIFY });
    });

    it("pqv не base64url или длиннее 4096 — malformed / pqv", () => {
      for (const value of ["a b", "a+b", "x".repeat(4097)]) {
        expect(failure(`${BASE}?type=tcp&security=reality&pbk=PUBLICKEY1&pqv=${encodeURIComponent(value)}`), value).toEqual({ reason: "malformed", detail: "pqv" });
      }
    });

    it("без pqv поля нет", () => {
      expect(node(L.VLESS_REALITY).security).not.toHaveProperty("mldsa65Verify");
    });
  });

  describe("flow", () => {
    it("xtls-rprx-vision-udp443 — узел", () => {
      expect(node(L.VLESS_VISION_UDP443).flow).toBe("xtls-rprx-vision-udp443");
    });

    it("режимы, убранные из Xray, — unsupported_option / flow", () => {
      for (const flow of ["xtls-rprx-direct", "xtls-rprx-origin", "xtls-rprx-splice", "xtls-rprx-vision-x", "other"]) {
        expect(failure(`${BASE}?flow=${flow}`), flow).toEqual({ reason: "unsupported_option", detail: "flow" });
      }
    });
  });

  describe("шифрование VLESS", () => {
    it("постквантовая строка уходит в cipher как есть", () => {
      expect(node(L.VLESS_ENCRYPTION).cipher).toBe(L.VLESS_ENCRYPTION_VALUE);
    });

    it("none и пусто — cipher: null", () => {
      expect(node(`${BASE}?encryption=none`).cipher).toBeNull();
      expect(node(`${BASE}?encryption=`).cipher).toBeNull();
      expect(node(BASE).cipher).toBeNull();
    });

    it("строка не по формату ядра — malformed / encryption: иначе Xray не примет весь конфиг", () => {
      for (const value of ["garbage", "mlkem768x25519plus.a b", `mlkem768x25519plus.${"x".repeat(4100)}`]) {
        expect(failure(`${BASE}?encryption=${encodeURIComponent(value)}`), value).toEqual({ reason: "malformed", detail: "encryption" });
      }
    });
  });

  describe("HTTP-маскировка RAW", () => {
    it("headerType=http у tcp: путь и хосты списками", () => {
      expect(node(L.VMESS_RAW_HTTP).transport).toEqual({ network: "tcp", rawHeader: L.RAW_HTTP_HEADER });
    });

    it("без path — «/», без host — заголовка Host нет", () => {
      expect(node(`${BASE}?type=tcp&headerType=http&security=tls`).transport).toEqual({
        network: "tcp",
        rawHeader: { type: "http", request: { path: ["/"], headers: {} } },
      });
    });

    it("vless: то же самое; у других сетей headerType игнорируется", () => {
      expect(node(`${BASE}?type=tcp&headerType=http&host=a.com&path=%2Fx%2C%2Fy&security=tls`).transport).toEqual({
        network: "tcp",
        rawHeader: { type: "http", request: { path: ["/x", "/y"], headers: { Host: ["a.com"] } } },
      });
      expect(node(`${BASE}?type=ws&headerType=http&security=none`).transport).toEqual({ network: "ws" });
    });

    it("none и пусто — как раньше, без заголовка; другое значение — unsupported_option / headerType", () => {
      expect(node(`${BASE}?type=tcp&headerType=none`).transport).toEqual({ network: "tcp" });
      for (const value of ["srtp", "utp", "wechat-video", "dtls", "wireguard"]) {
        expect(failure(`${BASE}?type=tcp&headerType=${value}`), value).toEqual({ reason: "unsupported_option", detail: "headerType" });
      }
    });

    it("знаки вне видимого ASCII в host и path — malformed / headerType: заголовок нельзя ломать переводом строки", () => {
      expect(failure(`${BASE}?type=tcp&headerType=http&host=${encodeURIComponent("a.com\r\nX: y")}`)).toEqual({ reason: "malformed", detail: "headerType" });
      expect(failure(`${BASE}?type=tcp&headerType=http&path=${encodeURIComponent("/a b")}`)).toEqual({ reason: "malformed", detail: "headerType" });
    });

    it("vmess JSON-форма: type=http у tcp — тот же заголовок", () => {
      const body = { v: "2", ps: "x", add: "203.0.113.12", port: "80", id: L.UUID, aid: "0", scy: "auto", net: "tcp", type: "http", host: "a.example.com,b.example.com", path: "/x" };
      expect(node(`vmess://${L.b64(JSON.stringify(body))}`).transport).toEqual({ network: "tcp", rawHeader: L.RAW_HTTP_HEADER });
      expect(failure(`vmess://${L.b64(JSON.stringify({ ...body, type: "srtp" }))}`)).toEqual({ reason: "unsupported_option", detail: "type" });
    });
  });

  it("в причинах отказа нет значений новых параметров", () => {
    const links = [
      `${tls}&ech=${encodeURIComponent("секрет ech")}`,
      `${tls}&pcs=topsecretpin`,
      `${BASE}?type=tcp&security=reality&pbk=PUBLICKEY1&pqv=${encodeURIComponent("секрет pqv")}`,
      `${BASE}?encryption=topsecretenc`,
      `${reality}&extra=topsecretextra`,
      `${BASE}?type=tcp&headerType=http&host=${encodeURIComponent("topsecret host")}`,
    ];
    for (const link of links) {
      const text = JSON.stringify(parseShareLink(link));
      for (const secret of ["секрет", "topsecret", L.UUID, "203.0.113.11"]) expect(text, `${secret} в ${link}`).not.toContain(secret);
    }
  });
});
