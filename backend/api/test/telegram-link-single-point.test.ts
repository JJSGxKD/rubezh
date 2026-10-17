import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Форму ссылки Telegram знает один файл (tasks/T-0091, Р100): иначе при смене
 * домена его придётся искать по модулям. Проверка по исходникам; сообщение
 * называет файл и строку.
 */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Где строка домена или диплинка разрешена, и почему. */
const ALLOWED = new Map<string, string>([
  ["platforms/telegram/telegram-link-format.ts", "единственное место, где собирается форма ссылки"],
  ["modules/settings/setting-catalog.ts", "тексты подсказок панели, не ссылка"],
]);

const LINK_SHAPE = /https:\/\/t\.me|tg:\/\/resolve|telegram\.me|telegram\.dog/;

function sourcesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name));
}

function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
}

describe("ссылки Telegram собираются в одном месте", () => {
  it("домен и форма диплинка зашиты только в форматтере", () => {
    const offenders: string[] = [];
    for (const file of sourcesOf(SRC)) {
      const path = relative(SRC, file).split(sep).join("/");
      if (ALLOWED.has(path)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (!isComment(line) && LINK_SHAPE.test(line)) offenders.push(`${path}:${index + 1}`);
        });
    }
    expect(offenders, `ссылки Telegram собирает только telegram-link-format.ts: ${offenders.join(", ")}`).toEqual([]);
  });
});
