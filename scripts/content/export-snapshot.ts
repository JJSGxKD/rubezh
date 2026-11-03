import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT_SNAPSHOT, type ContentSnapshot } from "../../packages/core-game/src/content/snapshot";
import { contentSnapshotJsonSchema } from "../../packages/core-game/src/content/snapshot-schema";

/**
 * Выгрузка снимка контента: `pnpm content:export` (docs/19-content-admin.md §3).
 *
 * Кладёт в `dist/` (вне git) три файла, по которым сервер и панель работают,
 * не импортируя пакеты игры:
 *  - `content-snapshot.json` — `CONTENT_SNAPSHOT`: из него сервер заводит
 *    версию 0 контента;
 *  - `content-snapshot.schema.json` — JSON-схема снимка: ею сервер проверяет
 *    форму правки;
 *  - `content-names.json` — тексты всех `nameKey` и `descriptionKey` снимка из
 *    словаря игры: по ним панель показывает имена, а не id.
 *
 * Словарь читается файлами `app-shell/src/i18n/*.json`: пакет `core-game`
 * оболочку не импортирует, и скрипт тоже не тянет её код ради текстов.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DICTIONARY_DIR = join(ROOT, "packages", "app-shell", "src", "i18n");
const DEFAULT_OUT_DIR = join(ROOT, "dist");

export const SNAPSHOT_FILE = "content-snapshot.json";
export const SCHEMA_FILE = "content-snapshot.schema.json";
export const NAMES_FILE = "content-names.json";

/** Ключ имени врага по соглашению оболочки: у врага в контенте поля ключа нет. */
const enemyNameKey = (id: string): string => `enemy.${id}.name`;

/** Все ключи имён и описаний, на которые ссылается снимок, без повторов и по порядку появления. */
export function collectNameKeys(snapshot: ContentSnapshot): string[] {
  const keys = new Set<string>();
  const add = (key: string | undefined): void => {
    if (key !== undefined) keys.add(key);
  };

  for (const enemy of snapshot.enemies) add(enemyNameKey(enemy.id));
  for (const stage of snapshot.stages) add(stage.nameKey);
  for (const group of [snapshot.weapons, snapshot.passives, snapshot.boosts, snapshot.difficulties]) {
    for (const item of group) {
      add(item.nameKey);
      add(item.descriptionKey);
    }
  }
  for (const map of snapshot.maps) add(map.nameKey);
  return [...keys];
}

/** Словарь игры: все плоские `*.json` каталога оболочки в один объект «ключ → текст». */
export function readDictionary(dir: string = DICTIONARY_DIR): Record<string, string> {
  const dictionary: Record<string, string> = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error(`${file}: ожидался объект «ключ → текст»`);
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") dictionary[key] = value;
    }
  }
  return dictionary;
}

export interface SnapshotExport {
  /** имя файла → содержимое */
  files: Record<string, string>;
  /** ключи снимка, для которых в словаре нет текста: панель покажет по ним id */
  missingNames: string[];
}

export function buildExport(snapshot: ContentSnapshot, dictionary: Readonly<Record<string, string>>): SnapshotExport {
  const names: Record<string, string> = {};
  const missingNames: string[] = [];
  for (const key of collectNameKeys(snapshot)) {
    const text = dictionary[key];
    if (text === undefined) missingNames.push(key);
    else names[key] = text;
  }

  return {
    files: {
      [SNAPSHOT_FILE]: `${JSON.stringify(snapshot, null, 2)}\n`,
      [SCHEMA_FILE]: `${JSON.stringify(contentSnapshotJsonSchema(), null, 2)}\n`,
      [NAMES_FILE]: `${JSON.stringify(names, null, 2)}\n`,
    },
    missingNames,
  };
}

/** Пишет выгрузку в каталог и возвращает её описание; каталог создаётся. */
export function writeExport(outDir: string = DEFAULT_OUT_DIR, snapshot: ContentSnapshot = CONTENT_SNAPSHOT): SnapshotExport {
  const result = buildExport(snapshot, readDictionary());
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(result.files)) writeFileSync(join(outDir, name), content, "utf8");
  return result;
}

/** Точка входа для `scripts/content/run-export.mjs`; возвращает код выхода. */
export function main(argv: readonly string[]): number {
  const outIndex = argv.indexOf("--out");
  const outDir = outIndex >= 0 && argv[outIndex + 1] !== undefined ? argv[outIndex + 1] : DEFAULT_OUT_DIR;
  const result = writeExport(outDir);
  for (const name of Object.keys(result.files)) console.log(`записан ${join(outDir, name)}`);
  if (result.missingNames.length > 0) {
    console.warn(`в словаре нет текстов для ключей (${result.missingNames.length}): ${result.missingNames.join(", ")}`);
  }
  return 0;
}
