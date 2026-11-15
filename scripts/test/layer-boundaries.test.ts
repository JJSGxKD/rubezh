import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — правила общие с хуком Claude Code, на чистом JS: типов у них нет и не нужно
import { BACKEND_MODULES, ENGINE_ENTRY, PLATFORM_ADAPTER, PORTS_FORBIDDEN, RULES, TEAM_TOOLS } from "../hooks/layer-rules.mjs";

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
 *
 * Список правил — `scripts/hooks/layer-rules.mjs`: его же читает хук Claude
 * Code, который проверяет один файл сразу после правки (Р224 A, T-0473).
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
    expect(collect("apps/sim-worker/src").length).toBeGreaterThan(5);
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

/**
 * Бэкенд: домен не знает, на какой он площадке (docs/35-stage4-plan.md, Р22,
 * §3.11). Доменные модули просят порты из `platforms/ports`, адаптеры живут в
 * `platforms/<площадка>`. Модуль считается доменным по умолчанию — новый не
 * проскочит мимо правила, — а исключения (`TEAM_TOOLS`) названы поимённо.
 */
describe("границы бэкенда", () => {
  const modules = readdirSync(join(ROOT, BACKEND_MODULES)).filter((name) => statSync(join(ROOT, BACKEND_MODULES, name)).isDirectory());

  it("вообще находит модули, а исключения — существуют", () => {
    expect(modules.length).toBeGreaterThan(8);
    for (const tool of TEAM_TOOLS) expect(modules, `исключение ${tool} больше не модуль — убрать из списка`).toContain(tool);
  });

  for (const name of modules.filter((module) => !TEAM_TOOLS.has(module))) {
    it(`модуль ${name} говорит с площадкой только через порты`, () => {
      for (const { path, source } of collect(`${BACKEND_MODULES}/${name}`)) {
        expect(source, shown(path)).not.toMatch(PLATFORM_ADAPTER);
      }
    });
  }

  it("порты не знают ни адаптеров, ни домена: это контракт, а не реализация", () => {
    for (const { path, source } of collect("backend/api/src/platforms/ports")) {
      expect(source, shown(path)).not.toMatch(PORTS_FORBIDDEN);
    }
  });
});
