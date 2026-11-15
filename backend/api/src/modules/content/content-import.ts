import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { assertSchemaSupported, validateJsonSchema } from "./content-json-schema.js";
import { CONTENT_SNAPSHOT_MAX_BYTES } from "./content-check.queue.js";
import { formatPointer } from "./content-path.js";
import type { ContentRepository } from "./content.repository.js";

/**
 * Версия «из кода» (docs/19-content-admin.md §3, tasks/T-0303): выкат заводит её
 * из выгрузки `pnpm content:export` командой `content:import`. Сервер пакеты игры
 * не импортирует, поэтому всё, что ему нужно знать о снимке, лежит в выгрузке
 * готовым: сам снимок, его JSON Schema, имена для панели и хэш движка.
 */

/** Имена файлов выгрузки — те же, что пишет `scripts/content/export-snapshot.ts` (тест сверяет). */
export const CONTENT_EXPORT_FILES = {
  snapshot: "content-snapshot.json",
  schema: "content-snapshot.schema.json",
  names: "content-names.json",
  hash: "content-hash.json",
} as const;

/** Тексты четырёх файлов как прочитаны с диска. */
export interface ContentExportFiles {
  snapshot: string;
  schema: string;
  names: string;
  hash: string;
}

export interface ParsedContentExport {
  contentHash: string;
  schemaVersion: number;
  snapshot: unknown;
  jsonSchema: unknown;
  names: Record<string, string>;
}

export interface ImportOutcome {
  created: boolean;
  versionNo: number;
  contentHash: string;
}

/** Причина отказа импорта — по-русски, с именем файла: её читает тот, кто запустил выкат. */
export class ContentImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentImportError";
  }
}

/**
 * Прочитать выгрузку: аргумент — каталог с четырьмя файлами или сам файл снимка
 * (остальные берутся рядом по стандартным именам).
 */
export function readContentExport(argument: string): ContentExportFiles {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(argument).isDirectory();
  } catch {
    throw new ContentImportError(`Нет файла или каталога выгрузки: ${argument}. Выгрузка делается командой pnpm content:export`);
  }
  const dir = isDirectory ? argument : dirname(argument);
  const snapshotPath = isDirectory ? join(dir, CONTENT_EXPORT_FILES.snapshot) : argument;
  const read = (path: string, label: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      throw new ContentImportError(`В выгрузке нет файла ${label} (${basename(path)} в ${dir}). Выгрузка делается командой pnpm content:export`);
    }
  };
  return {
    snapshot: read(snapshotPath, CONTENT_EXPORT_FILES.snapshot),
    schema: read(join(dir, CONTENT_EXPORT_FILES.schema), CONTENT_EXPORT_FILES.schema),
    names: read(join(dir, CONTENT_EXPORT_FILES.names), CONTENT_EXPORT_FILES.names),
    hash: read(join(dir, CONTENT_EXPORT_FILES.hash), CONTENT_EXPORT_FILES.hash),
  };
}

const hashFileSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{8,64}$/) });
const namesFileSchema = z.record(z.string(), z.string());
const schemaVersionSchema = z.int().min(1).max(32_767);

function json(text: string, file: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new ContentImportError(`${file}: не JSON — ${error instanceof Error ? error.message : "ошибка разбора"}`);
  }
}

/**
 * Разобрать и проверить выгрузку. Снимок обязан соответствовать своей же схеме —
 * ровно той проверкой, которой потом проверяются правки черновиков: версию, не
 * проходящую её, правка бы испортила сразу.
 */
export function parseContentExport(files: ContentExportFiles): ParsedContentExport {
  if (Buffer.byteLength(files.snapshot, "utf8") > CONTENT_SNAPSHOT_MAX_BYTES) {
    throw new ContentImportError(`${CONTENT_EXPORT_FILES.snapshot}: снимок больше 2 МБ — воркер симуляции такой не разбирает`);
  }
  const snapshot = json(files.snapshot, CONTENT_EXPORT_FILES.snapshot);
  const jsonSchema = json(files.schema, CONTENT_EXPORT_FILES.schema);

  const hash = hashFileSchema.safeParse(json(files.hash, CONTENT_EXPORT_FILES.hash));
  if (!hash.success) throw new ContentImportError(`${CONTENT_EXPORT_FILES.hash}: хэш должен быть шестнадцатеричной строкой из 8–64 знаков, как его пишет pnpm content:export`);
  const names = namesFileSchema.safeParse(json(files.names, CONTENT_EXPORT_FILES.names));
  if (!names.success) throw new ContentImportError(`${CONTENT_EXPORT_FILES.names}: ожидался объект «ключ → текст»`);

  try {
    assertSchemaSupported(jsonSchema);
  } catch (error: unknown) {
    throw new ContentImportError(`${CONTENT_EXPORT_FILES.schema}: ${error instanceof Error ? error.message : "схема не годится"}`);
  }
  const violations = validateJsonSchema(jsonSchema, snapshot);
  const first = violations[0];
  if (first !== undefined) {
    const more = violations.length > 1 ? ` (и ещё нарушений: ${String(violations.length - 1)})` : "";
    throw new ContentImportError(`${CONTENT_EXPORT_FILES.snapshot}: ${formatPointer(snapshot, first.pointer) || "снимок"}: ${first.message}${more}`);
  }

  const schemaVersion = schemaVersionSchema.safeParse((snapshot as { schemaVersion?: unknown }).schemaVersion);
  if (!schemaVersion.success) throw new ContentImportError(`${CONTENT_EXPORT_FILES.snapshot}: schemaVersion — целое от 1 до 32767`);
  return { contentHash: hash.data.hash, schemaVersion: schemaVersion.data, snapshot, jsonSchema, names: names.data };
}

/**
 * Завести версию `repo`. Тот же хэш — ничего не меняется, возвращается номер
 * существующей: выкат повторяют, и версия от этого не размножается.
 */
export async function importContentVersion(repository: ContentRepository, parsed: ParsedContentExport, now: Date): Promise<ImportOutcome> {
  const { created, version } = await repository.addVersion({
    contentHash: parsed.contentHash,
    schemaVersion: parsed.schemaVersion,
    snapshot: parsed.snapshot,
    jsonSchema: parsed.jsonSchema,
    names: parsed.names,
    source: "repo",
    createdBy: null,
    createdAt: now,
  });
  return { created, versionNo: version.versionNo, contentHash: version.contentHash };
}
