import { open } from "node:fs/promises";
import { formatXrayVersion, parseXrayVersion } from "@bh/proxy-kit";
import { STATUS_MAX_BYTES } from "./xray-core-target.js";

/**
 * Запущенная версия ядра — из файла, который пишет контейнер Xray при старте
 * (docs/35-stage4-plan.md Р202, tasks/T-0415): две строки `version=…` и
 * `started=…`. API файл только читает: доступа к Docker с сервера нет.
 */
export type CoreStatus = { state: "ok"; version: string; startedAt: Date | null } | { state: "missing" } | { state: "unreadable" };

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Строки `ключ=значение`; лишние ключи и пустые строки пропускаются, CRLF допустим. */
export function parseCoreStatus(text: string): CoreStatus {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (!values.has(key)) values.set(key, line.slice(at + 1).trim());
  }
  const parsed = parseXrayVersion(values.get("version") ?? "");
  if (parsed === null) return { state: "unreadable" };
  const started = values.get("started") ?? "";
  const startedAt = ISO_UTC.test(started) && !Number.isNaN(Date.parse(started)) ? new Date(started) : null;
  return { state: "ok", version: formatXrayVersion(parsed), startedAt };
}

/** Первые `max` байт файла: длинный файл читать целиком незачем. */
export async function readHead(path: string, max: number): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(max);
    const { bytesRead } = await file.read(buffer, 0, max, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/** Нет файла — `missing` (в dev контейнера нет); длиннее предела и любая другая ошибка чтения — `unreadable`. */
export async function readCoreStatus(path: string, read: (path: string, max: number) => Promise<Buffer> = readHead): Promise<CoreStatus> {
  let bytes: Buffer;
  try {
    bytes = await read(path, STATUS_MAX_BYTES + 1);
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : null;
    return code === "ENOENT" ? { state: "missing" } : { state: "unreadable" };
  }
  if (bytes.length > STATUS_MAX_BYTES) return { state: "unreadable" };
  return parseCoreStatus(bytes.toString("utf8"));
}
