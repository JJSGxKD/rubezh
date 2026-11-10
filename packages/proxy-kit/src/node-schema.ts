import { z } from "zod";
import type { ProxyNode } from "./node.js";

/**
 * Схема узла для чтения с диска: бэкенд хранит узлы подписки (с секретами
 * UUID и паролем) файлами-частями в общем томе, а данные с диска — граница
 * системы. Схема строго по типу `ProxyNode`: лишнее поле или неизвестное
 * значение — отказ, а не молчаливая подстановка. `satisfies` ниже ломает
 * сборку, если тип и схема разошлись.
 */

const transportSchema = z.strictObject({
  network: z.enum(["tcp", "ws", "grpc", "httpupgrade", "xhttp"]),
  path: z.string().optional(),
  host: z.string().optional(),
  serviceName: z.string().optional(),
  mode: z.string().optional(),
});

const securitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("tls"), serverName: z.string(), alpn: z.array(z.string()), fingerprint: z.string().nullable() }),
  z.strictObject({ kind: z.literal("reality"), serverName: z.string(), fingerprint: z.string(), publicKey: z.string(), shortId: z.string(), spiderX: z.string() }),
]);

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
}) satisfies z.ZodType<ProxyNode>;
