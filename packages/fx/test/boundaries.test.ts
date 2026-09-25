import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Границы пакета курсов (docs/35-stage4-plan.md §3.12, Р32): ядро без
 * зависимостей от игры, Nest и Prisma — только порты. Проверка по
 * исходникам, как у слоёв клиента (scripts/test/layer-boundaries.test.ts);
 * живёт в пакете, потому что правила — про его внутренности.
 */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

interface Rule {
  forbidden: RegExp;
  why: string;
  /** файлы, которым правило не писано */
  except?: RegExp;
}

const RULES: Rule[] = [
  { forbidden: /["']@bh\//, why: "ядро курсов не знает о монорепо: игре оно нужно, а не наоборот" },
  { forbidden: /["'](@nestjs\/|@prisma\/|prisma|ioredis|bullmq)["'/]/, why: "Nest, Prisma и Redis — за портами в модуле бэкенда, не в пакете" },
  { forbidden: /["'](phaser|react)["'/]/, why: "к клиенту пакет отношения не имеет" },
  { forbidden: /process\.env/, why: "конфигурация приходит параметрами: process.env читает только модуль конфигурации бэкенда" },
  { forbidden: /Date\.now\(|new Date\(\)|Math\.random\(/, why: "время и случайность — только через порты, иначе расписание не проверить тестом", except: /ports[\\/]clock\.ts$/ },
  { forbidden: /from\s+["']\.{1,2}\/[^"']+(?<!\.js)["']/, why: "относительный импорт без .js не разрешится в собранном ESM для бэкенда" },
];

function collect(root: string): { path: string; source: string }[] {
  const result: { path: string; source: string }[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) result.push(...collect(path));
    else if (/\.ts$/.test(entry)) result.push({ path, source: readFileSync(path, "utf8") });
  }
  return result;
}

describe("границы packages/fx", () => {
  const files = collect(SRC);

  it("находит исходники — иначе тест зелёный впустую", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  for (const rule of RULES) {
    it(rule.why, () => {
      for (const { path, source } of files) {
        if (rule.except?.test(path)) continue;
        expect(source, path.split(sep).join("/")).not.toMatch(rule.forbidden);
      }
    });
  }
});
