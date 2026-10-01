import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reasonTitle } from "../src/api/review";
import { HELP } from "../src/ui/help";

// Пояснения панели (значок «?»): у каждого текста есть место на экране, иначе
// словарь копит мёртвые строки, которые никто не обновит вместе с правилом.

const SCREENS = fileURLToPath(new URL("../src/screens", import.meta.url));

function sources(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".tsx") ? readFileSync(join(dir, entry.name), "utf8") : ""))
    .join("\n");
}

const entries = Object.entries(HELP).flatMap(([section, texts]) => Object.entries(texts).map(([key, text]): [string, string] => [`HELP.${section}.${key}`, text]));

describe("пояснения панели", () => {
  it("каждое пояснение стоит на экране", () => {
    const code = sources(SCREENS);
    expect(entries.filter(([path]) => !code.includes(path)).map(([path]) => path)).toEqual([]);
  });

  it("текст — фраза, а не простыня: подсказка шириной 288 px читается в несколько строк", () => {
    for (const [path, text] of entries) {
      expect(text.trim(), path).not.toBe("");
      expect(text.length, path).toBeLessThanOrEqual(400);
    }
  });

  it("причины разбора — словами; незнакомый код новее панели — как есть", () => {
    expect(reasonTitle("unverified_time")).toBe("старт не дошёл — время забега не проверено");
    expect(reasonTitle("boost_unpaid")).toBe("буст не куплен на этот забег");
    expect(reasonTitle("something_new")).toBe("something_new");
  });
});
