import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ALPHA2_TO_ALPHA3, countryName, flagSrc } from "../src/ui/country-codes";
import { CountryFlag } from "../src/ui/country-flag";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = (code: string | null) => renderToStaticMarkup(createElement(CountryFlag, { code }));

describe("таблица кодов стран", () => {
  const pairs = Object.entries(ALPHA2_TO_ALPHA3);

  it("каждая пара — две и три заглавные буквы, и файл флага есть", () => {
    for (const [a2, a3] of pairs) {
      expect(a2, a2).toMatch(/^[A-Z]{2}$/);
      expect(a3, a3).toMatch(/^[A-Z]{3}$/);
      expect(existsSync(join(root, "public", "flags", `${a3.toLowerCase()}.svg`)), `${a2} → ${a3}`).toBe(true);
    }
  });

  it("три буквы не повторяются, кроме псевдонима UK", () => {
    const seen = new Map<string, string>();
    for (const [a2, a3] of pairs) {
      const prev = seen.get(a3);
      if (prev !== undefined) expect([prev, a2].sort()).toEqual(["GB", "UK"]);
      seen.set(a3, a2);
    }
  });

  it("пар не меньше 240", () => {
    expect(pairs.length).toBeGreaterThanOrEqual(240);
  });

  it("частые путаницы разрешены верно", () => {
    const expected: Record<string, string> = {
      NL: "NLD", DE: "DEU", GB: "GBR", UK: "GBR", US: "USA", RU: "RUS", AT: "AUT", AU: "AUS", NE: "NER", NG: "NGA",
      SK: "SVK", SI: "SVN", KR: "KOR", KP: "PRK", CH: "CHE", CN: "CHN", CZ: "CZE", AE: "ARE", TR: "TUR", HK: "HKG",
      TW: "TWN", MD: "MDA", ME: "MNE", MK: "MKD", KZ: "KAZ", UA: "UKR", BY: "BLR",
    };
    for (const [a2, a3] of Object.entries(expected)) expect(ALPHA2_TO_ALPHA3[a2], a2).toBe(a3);
  });
});

describe("flagSrc и countryName", () => {
  it("flagSrc: регистр и пробелы не важны, неизвестный и null — null", () => {
    expect(flagSrc(" nl ")).toBe("./flags/nld.svg");
    expect(flagSrc("XX")).toBeNull();
    expect(flagSrc(null)).toBeNull();
  });

  it("countryName: по-русски, неизвестное не бросает", () => {
    expect(countryName("NL")).toBe("Нидерланды");
    expect(countryName("XX").length).toBeGreaterThan(0);
  });
});

describe("CountryFlag", () => {
  it("известная страна — картинка, код и название", () => {
    const out = html("nl");
    expect(out).toContain("<img");
    expect(out).toContain('src="./flags/nld.svg"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('alt=""');
    expect(out).toContain('width="21"');
    expect(out).toContain('height="16"');
    expect(out).toContain("NL");
    expect(out).toContain('title="Нидерланды"');
  });

  it("неизвестный код — только текст, без картинки", () => {
    const out = html("XX");
    expect(out).not.toContain("<img");
    expect(out).toContain("XX");
  });

  it("нет страны — прочерк", () => {
    const out = html(null);
    expect(out).toContain("—");
    expect(out).not.toContain("<img");
  });
});

describe("код панели", () => {
  it("не импортирует SVG", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(root, "src"));
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+["'][^"']+\.svg(\?[^"']*)?["']/);
  });
});
