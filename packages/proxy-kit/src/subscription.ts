import { decodeBase64 } from "./internal/base64.js";
import type { ProxyNode, SkipReason } from "./node.js";
import { parseShareLink } from "./share-link.js";

/** Сколько ссылок разбирается из одной подписки; остальное — `truncated`. */
const DEFAULT_MAX_LINKS = 1000;

export interface SkippedLink {
  /** номер ссылки среди ссылок подписки с нуля (комментарии и пустые строки не считаются) */
  index: number;
  /** схема ссылки; для неразобранной — `unknown` */
  scheme: string;
  reason: SkipReason;
  /** имя параметра или схема — никогда не кусок ссылки */
  detail: string;
}

export interface SubscriptionParse {
  format: "base64" | "plain";
  nodes: ProxyNode[];
  skipped: SkippedLink[];
  /** ссылок оказалось больше `maxLinks`: остальные не разбирались */
  truncated: boolean;
}

/** Тело подписки — не тот формат, который мы умеем (Clash, sing-box, JSON), либо пустое. */
export class SubscriptionFormatError extends Error {
  readonly code: "unsupported_format" | "empty";

  constructor(code: "unsupported_format" | "empty") {
    super(code === "empty" ? "Подписка пуста" : "Формат подписки не поддерживается: ждём список ссылок открытым текстом или в base64");
    this.name = "SubscriptionFormatError";
    this.code = code;
  }
}

/**
 * Подписка — список ссылок по одной в строке, открытым текстом или в base64
 * (обычном или URL-safe, с `=` или без). Остальные форматы не угадываются.
 * Плохая ссылка уходит в `skipped` с причиной и не роняет остальные; одинаковые
 * узлы (один `key`) схлопываются.
 */
export function parseSubscription(body: string, options: { maxLinks?: number } = {}): SubscriptionParse {
  const maxLinks = options.maxLinks ?? DEFAULT_MAX_LINKS;
  const text = body.replace(/^﻿/, "").trim();
  if (text === "") throw new SubscriptionFormatError("empty");

  let format: SubscriptionParse["format"] = "plain";
  let links = linkLines(text);
  if (links.length === 0) {
    const decoded = decodeBase64(text);
    if (decoded === null) throw new SubscriptionFormatError("unsupported_format");
    if (decoded.trim() === "") throw new SubscriptionFormatError("empty");
    format = "base64";
    links = linkLines(decoded);
    if (links.length === 0) throw new SubscriptionFormatError("unsupported_format");
  }

  const nodes = new Map<string, ProxyNode>();
  const skipped: SkippedLink[] = [];
  links.slice(0, maxLinks).forEach((link, index) => {
    const result = parseShareLink(link);
    if (result.ok) {
      if (!nodes.has(result.node.key)) nodes.set(result.node.key, result.node);
      return;
    }
    skipped.push({ index, scheme: /^([a-z][a-z0-9+.-]*):\/\//i.exec(link)?.[1]?.toLowerCase() ?? "unknown", reason: result.reason, detail: result.detail });
  });
  return { format, nodes: [...nodes.values()], skipped, truncated: links.length > maxLinks };
}

/** Строки со ссылками: пустые, `#`-комментарии и строки без `://` пропускаются молча. */
function linkLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && line.includes("://"));
}

export interface UserInfo {
  uploadBytes: number | null;
  downloadBytes: number | null;
  totalBytes: number | null;
  expireUnixSec: number | null;
}

/** `Subscription-Userinfo: upload=…; download=…; total=…; expire=…`; мусор и пустое — `null`. */
export function parseUserInfo(header: string | null): UserInfo | null {
  if (header === null) return null;
  const values = new Map<string, number>();
  for (const part of header.split(";")) {
    const [name, value] = part.split("=").map((item) => item.trim());
    if (name === undefined || value === undefined || !/^\d+$/.test(value)) continue;
    values.set(name.toLowerCase(), Number(value));
  }
  if (values.size === 0) return null;
  return {
    uploadBytes: values.get("upload") ?? null,
    downloadBytes: values.get("download") ?? null,
    totalBytes: values.get("total") ?? null,
    expireUnixSec: values.get("expire") ?? null,
  };
}

/** `Profile-Update-Interval` — часы от 1 до 168; остальное `null`. */
export function parseUpdateIntervalHours(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  const hours = Number(header.trim());
  return hours >= 1 && hours <= 168 ? hours : null;
}
