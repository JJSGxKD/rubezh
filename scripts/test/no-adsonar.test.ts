import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Закрытая рекламная сеть не возвращается в код (Р206, T-0428): сеть закрылась
 * 16.10.2026, её интеграцию вырезали целиком. Проверка обходит исходники и
 * тесты и падает на любом упоминании имени — путь и строка в сообщении.
 *
 * Миграции в обход не входят: начальная миграция `ads` вставляла строку сети в
 * справочник, и историю базы не переписывают. Сгенерированный клиент Prisma
 * (`generated`) тоже пропускается: в нём совпадает не сеть, а `JsonArray`.
 * Тесты, которым нужно имя закрытой сети (неизвестная сеть в адаптере, проверка
 * справочника), собирают его из частей.
 */
const SELF = resolve(fileURLToPath(import.meta.url));
const ROOT = resolve(dirname(SELF), "..", "..");

const FORBIDDEN = /sonar/i;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "generated"]);
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Каталоги и файлы, где ищем: исходники и тесты бэкенда, пакетов и приложений, настройки сборки. */
function searchRoots(): string[] {
  const roots = [join(ROOT, "backend", "api", "src"), join(ROOT, "backend", "api", "test"), join(ROOT, "scripts", "vite"), join(ROOT, "scripts", "bundle-budget.mjs")];
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(ROOT, group))) {
      roots.push(join(ROOT, group, name, "src"), join(ROOT, group, name, "test"));
    }
  }
  return roots;
}

function isSearched(path: string): boolean {
  if (SOURCE_FILE.test(path)) return true;
  // Тексты интерфейса — словари перевода.
  return path.endsWith(".json") && path.split(sep).includes("i18n");
}

function collect(path: string, found: string[]): void {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return; // у пакета может не быть src или test
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (!SKIPPED_DIRS.has(name)) collect(join(path, name), found);
    }
  } else if (isSearched(path) && resolve(path) !== SELF) {
    found.push(path);
  }
}

/** Строки с упоминанием: `путь:номер`. */
function mentions(text: string, label: string): string[] {
  return text.split(/\r?\n/).flatMap((line, index) => (FORBIDDEN.test(line) ? [`${label}:${String(index + 1)}`] : []));
}

describe("закрытая рекламная сеть", () => {
  it("в исходниках и тестах не упоминается", () => {
    const files: string[] = [];
    for (const root of searchRoots()) collect(root, files);
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((file) => mentions(readFileSync(file, "utf8"), relative(ROOT, file).split(sep).join("/")));
    expect(found).toEqual([]);
  });

  it("проверка ловит упоминание в любом регистре и называет строку", () => {
    const text = ["const a = 1;", "// старое имя: " + "Son" + "ar", "export const adso" + "nar = 2;"].join("\n");
    expect(mentions(text, "x.ts")).toEqual(["x.ts:2", "x.ts:3"]);
    expect(mentions("ничего лишнего\r\nи тут нет", "y.ts")).toEqual([]);
  });
});
