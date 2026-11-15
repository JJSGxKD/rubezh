import { z } from "zod";
import { jsonObjectOf } from "./internal/json.js";
import type { ProxyNode } from "./node.js";

/**
 * Схема узла для чтения с диска: бэкенд хранит узлы подписки (с секретами
 * UUID и паролем) файлами-частями в общем томе, а данные с диска — граница
 * системы. Схема строго по типу `ProxyNode`: лишнее поле или неизвестное
 * значение — отказ, а не молчаливая подстановка. `satisfies` ниже ломает
 * сборку, если тип и схема разошлись.
 *
 * Объекты, которые уходят в конфиг Xray как есть (`extra`, заголовок RAW,
 * настройки `freedom`), держатся в тех же пределах, что при разборе подписки, а
 * `redirect` в настройках цепочки недопустим и здесь: он перенаправил бы трафик
 * узла на другой адрес.
 */

/** Объект в пределах `jsonObjectOf`: размер и глубина. */
const boundedObject = z.record(z.string(), z.unknown()).refine((value) => jsonObjectOf(value) !== null, "объект слишком большой или глубокий");

const transportSchema = z.strictObject({
  network: z.enum(["tcp", "ws", "grpc", "httpupgrade", "xhttp"]),
  path: z.string().optional(),
  host: z.string().optional(),
  serviceName: z.string().optional(),
  mode: z.string().optional(),
  extra: boundedObject.optional(),
  rawHeader: boundedObject.optional(),
});

const textList = z.array(z.string());

const legacyPinningSchema = z.strictObject({
  pinnedPeerCertificateChainSha256: textList.optional(),
  pinnedPeerCertificatePublicKeySha256: textList.optional(),
  verifyPeerCertInNames: textList.optional(),
});

const securitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("tls"),
    serverName: z.string(),
    alpn: z.array(z.string()),
    fingerprint: z.string().nullable(),
    ech: z.string().optional(),
    echForceQuery: z.enum(["none", "half", "full"]).optional(),
    pinnedPeerCertSha256: z.string().optional(),
    verifyPeerCertByName: z.string().optional(),
    legacyPinning: legacyPinningSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("reality"),
    serverName: z.string(),
    fingerprint: z.string(),
    publicKey: z.string(),
    shortId: z.string(),
    spiderX: z.string(),
    mldsa65Verify: z.string().optional(),
  }),
]);

const dialerSchema = z.strictObject({
  settings: boundedObject.refine((settings) => !("redirect" in settings), "redirect в настройках цепочки недопустим"),
});

export const proxyNodeSchema = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{16}$/),
  protocol: z.enum(["vless", "vmess", "trojan", "shadowsocks"]),
  name: z.string(),
  country: z.string().nullable(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  secret: z.string(),
  flow: z.string().nullable(),
  cipher: z.string().nullable(),
  transport: transportSchema,
  security: securitySchema,
  dialer: dialerSchema.optional(),
}) satisfies z.ZodType<ProxyNode>;
