import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Имена файлов, которые Windows не различает (CLAUDE.md, «Окружение команды»).
 *
 * Команда работает на Windows, CI и сервер — на Linux. Два файла, чьи имена
 * совпадают без учёта регистра, ломают одну из сторон молча: `App.tsx` и
 * `app.ts` в одном каталоге на Linux собираются, а на Windows импорт `./App`
 * попадает в `app.ts`, и сборка падает у всех, кто её запускает локально.
 * Того же рода — модуль с одним именем и разными расширениями: `./App`
 * разрешается в зависимости от порядка расширений сборщика.
 *
 * Список берётся из git, а не с диска: проверяется то, что уедет в
 * репозиторий, без `node_modules` и сборок.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const MODULE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path.length > 0);
}

/** Группы путей с одним ключом, если в группе больше одного. */
function collisions(paths: readonly string[], key: (path: string) => string): string[][] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const group = groups.get(key(path)) ?? [];
    group.push(path);
    groups.set(key(path), group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

describe("имена файлов", () => {
  const files = trackedFiles();

  it("не совпадают без учёта регистра — Windows их не различает", () => {
    expect(collisions(files, (path) => path.toLowerCase())).toEqual([]);
  });

  it("модуль в каталоге один на имя, независимо от регистра и расширения", () => {
    const modules = files.filter((path) => MODULE_EXTENSIONS.test(path) && !path.endsWith(".d.ts"));
    expect(collisions(modules, (path) => path.replace(MODULE_EXTENSIONS, "").toLowerCase())).toEqual([]);
  });
});
