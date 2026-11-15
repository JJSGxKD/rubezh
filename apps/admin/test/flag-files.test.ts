import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const flagsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "flags");

// Независимая от скрипта импорта проверка: файлы отдаёт свой домен панели.
const UNSAFE = /<script|<foreignObject|\son[a-z]+\s*=|href\s*=\s*["']https?:/i;

const files = existsSync(flagsDir) ? readdirSync(flagsDir).filter((f) => f.endsWith(".svg")) : [];

describe("выражение проверки безопасности SVG", () => {
  it("ловит скрипт", () => {
    expect(UNSAFE.test('<svg viewBox="0 0 1 1"><script>x()</script></svg>')).toBe(true);
  });
  it("ловит обработчик события", () => {
    expect(UNSAFE.test('<svg onload="x()">')).toBe(true);
  });
  it("ловит внешнюю ссылку", () => {
    expect(UNSAFE.test('<svg><image href="https://example.com/a.png"/></svg>')).toBe(true);
  });
  it("пропускает чистый флаг", () => {
    expect(UNSAFE.test('<svg viewBox="0 0 52 40"><path d="M0 0h52v40H0z"/></svg>')).toBe(false);
  });
});

describe("файлы флагов панели", () => {
  it("их не меньше 240", () => {
    expect(files.length).toBeGreaterThanOrEqual(240);
  });

  it("имена — три строчные латинские буквы", () => {
    const bad = files.filter((f) => !/^[a-z]{3}\.svg$/.test(f));
    expect(bad).toEqual([]);
  });

  it("каждый файл — svg с viewBox и без опасного содержимого", () => {
    for (const f of files) {
      const text = readFileSync(join(flagsDir, f), "utf8");
      expect(text.startsWith("<svg"), `${f}: начало`).toBe(true);
      expect(text.includes("viewBox"), `${f}: viewBox`).toBe(true);
      expect(UNSAFE.test(text), `${f}: опасное содержимое`).toBe(false);
    }
  });

  it("сжатие было: каждый файл до 400 КБ, все вместе до 5 МБ", () => {
    let total = 0;
    for (const f of files) {
      const size = statSync(join(flagsDir, f)).size;
      expect(size, `${f}: размер`).toBeLessThanOrEqual(400 * 1024);
      total += size;
    }
    expect(total).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it("основные флаги на месте", () => {
    for (const n of ["nld", "deu", "usa", "rus", "gbr"]) {
      expect(files, n).toContain(`${n}.svg`);
    }
  });
});
