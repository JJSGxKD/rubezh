import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Метка «Отдельная доска» (T-0115) живёт только в отчётах панели. Внешние
 * цифры — постбэки сетям, кабинет партнёров, выплаты, рефералы, платежи — и
 * чат читают аккаунт как обычного игрока и метки знать не должны: тест по
 * исходникам, как `scripts/test/layer-boundaries.test.ts`.
 */

const MODULES = join(import.meta.dirname, "..", "src", "modules");

/** Каталоги модулей, которые метку не читают. */
const CLOSED_DIRS = ["ad-conversions", "ads", "attribution", "links", "partners", "referrals", "payments", "wallet", "shop", "friends", "home", "export"];
/** Отдельные файлы: тексты, уходящие в чаты, и отчёт по долям флагов. */
const CLOSED_FILES = ["admin-notify/daily-stats.ts", "admin-notify/run-card.ts", "admin-notify/run-review-card.ts", "funnel/flag-split-report.ts"];
const FORBIDDEN = [/separate_board/, /board-mark/i, /boardMark/, /BOARD_MARK/];

function sources(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => sources(join(path, name)));
}

describe("метка «Отдельная доска» не выходит за отчёты панели", () => {
  const files = [...CLOSED_DIRS.flatMap((dir) => sources(join(MODULES, dir))), ...CLOSED_FILES.map((file) => join(MODULES, file))].filter((file) => file.endsWith(".ts"));

  it("закрытые каталоги и файлы найдены", () => {
    expect(files.length).toBeGreaterThan(20);
    for (const file of CLOSED_FILES) expect(statSync(join(MODULES, file)).isFile()).toBe(true);
  });

  it("в них нет ни вида, ни метки", () => {
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) if (pattern.test(text)) found.push(`${relative(MODULES, file)}: ${String(pattern)}`);
    }
    expect(found).toEqual([]);
  });
});
