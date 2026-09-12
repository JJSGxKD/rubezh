import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Границы слоёв по исходникам (CLAUDE.md, «Границы слоёв — жёсткие»;
 * docs/15-engineering-standards.md §2.2; docs/27-design-system-and-app-shell.md §2).
 *
 * Проверка исходников, а не линт границ: правил немного, они читаются
 * человеком, а сообщение теста называет файл и нарушенное правило. Линт с
 * плагином границ пришлось бы настраивать дольше, чем занимает этот файл.
 *
 * Тест общий для репозитория и потому живёт в `scripts/test`, а не в пакете:
 * он про отношения между пакетами, а не про содержимое одного.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface Rule {
  /** какой пакет проверяем */
  from: string;
  /** что ему запрещено импортировать */
  forbidden: RegExp;
  why: string;
}

const RULES: Rule[] = [
  {
    from: "packages/app-shell/src",
    forbidden: /["']@bh\/adapter-/,
    why: "оболочка не знает о площадках: адаптер приходит готовым объектом из apps/web-*",
  },
  {
    from: "packages/app-shell/src",
    forbidden: /["']phaser["']/i,
    why: "Phaser уходит отдельным чанком; прямой импорт затянул бы его в первую загрузку",
  },
  {
    from: "packages/app-shell/src",
    forbidden: /["']@bh\/core-game\//,
    why: "движок берётся только через публичный API index.ts, внутренности забега — не контракт",
  },
  {
    from: "packages/core-game/src",
    forbidden: /["']@bh\/app-shell/,
    why: "движок ничего не знает о том, кто и чем рисует меню",
  },
  {
    from: "packages/core-game/src",
    forbidden: /["']react/,
    why: "движок не знает о React: оболочка приходит к нему, а не наоборот",
  },
  {
    from: "packages/core-game/src",
    forbidden: /["']@bh\/adapter-/,
    why: "движок общается с площадкой только через PlatformAdapter из shared-types",
  },
  {
    from: "packages/shared-types/src",
    forbidden: /["']@bh\//,
    why: "shared-types — корень зависимостей и не импортирует ничего из монорепо",
  },
  {
    from: "packages/core-game/src/content",
    forbidden: /["']\.\.\/game\//,
    why: "контент — это данные: он не знает о коде движка",
  },
];

/** Публичная дверь движка: только этот файл вправе тянуть Phaser в оболочке. */
const ENGINE_ENTRY = "packages/core-game/src/index.ts";

/** Путь в сообщении — со слэшами: тест читают и на Windows, и в логе CI. */
function shown(path: string): string {
  return path.split(sep).join("/");
}

function collect(relativeRoot: string): { path: string; source: string }[] {
  const root = join(ROOT, relativeRoot);
  const result: { path: string; source: string }[] = [];

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      result.push(...collect(join(relativeRoot, entry)));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    result.push({ path: join(relativeRoot, entry), source: readFileSync(path, "utf8") });
  }
  return result;
}

describe("границы слоёв", () => {
  it("вообще находит исходники — иначе тест зелёный впустую", () => {
    expect(collect("packages/app-shell/src").length).toBeGreaterThan(10);
    expect(collect("packages/core-game/src").length).toBeGreaterThan(10);
  });

  for (const rule of RULES) {
    it(`${rule.from}: ${rule.why}`, () => {
      for (const { path, source } of collect(rule.from)) {
        expect(source, shown(path)).not.toMatch(rule.forbidden);
      }
    });
  }

  it("держит Phaser за дверью динамического импорта", () => {
    const entry = readFileSync(join(ROOT, ENGINE_ENTRY), "utf8");
    // Статический импорт в index.ts утащил бы полтора мегабайта в первую
    // загрузку — бюджет бандла поймал бы это позже и больнее.
    expect(entry).not.toMatch(/^import .*["']phaser["']/m);
    expect(entry).toMatch(/await import\(/);
  });

  it("не даёт адаптерам знать друг о друге", () => {
    for (const platform of ["telegram", "max", "vk"]) {
      const others = ["telegram", "max", "vk"].filter((name) => name !== platform);
      for (const { path, source } of collect(`packages/adapter-${platform}/src`)) {
        for (const other of others) {
          expect(source, shown(path)).not.toContain(`@bh/adapter-${other}`);
        }
      }
    }
  });
});
