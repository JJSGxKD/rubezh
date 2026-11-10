import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LINKS_GUIDE, type GuideBlock, type GuideSection } from "../src/screens/links/links-guide";

// Справка по ссылкам в разделе «Ссылки» (T-0372): текст живёт в одном массиве, а
// окно только рисует его. Тесты держат форму справки и привязку к коду: ключ
// настроек, которого нет в каталоге, или раздел, потерянный при правке, — красный.

/** Разделы справки по порядку (решение 4 задачи): по ним строится оглавление окна. */
const SECTION_IDS = ["kinds", "click-path", "fields", "counters", "network", "keys", "troubleshooting", "more"];

/**
 * Ключи каталогов, о которых справка говорит. Фикстура собрана руками из двух файлов:
 * - настройки — `backend/api/src/modules/settings/setting-catalog.ts` (значение `key`);
 * - ключи интеграций — `backend/api/src/modules/secrets/secret-catalog.ts` (значение `key`).
 * Ключ, упомянутый в справке, обязан быть здесь; ключ отсюда обязан быть в самом каталоге
 * (проверка ниже читает исходники), поэтому переименование в каталоге роняет и этот тест.
 */
const CATALOG = {
  settings: { file: "../../../backend/api/src/modules/settings/setting-catalog.ts", keys: ["telegram.link-host", "links.auto-daily-cap"] },
  secrets: { file: "../../../backend/api/src/modules/secrets/secret-catalog.ts", keys: ["adsgram.conversion-token", "adsgram.reward-secret"] },
} as const;

/**
 * Ключи, которые влияют на ссылки, переход и конверсии: справка обязана их перечислить.
 * `adsgram.reward-secret` сюда не входит — это награда за задания AdsGram; справка упоминает его
 * лишь затем, чтобы его не путали с токеном конверсий.
 */
const AFFECTS_LINKS = ["telegram.link-host", "links.auto-daily-cap", "adsgram.conversion-token"];

const FIXTURE_KEYS: readonly string[] = [...CATALOG.settings.keys, ...CATALOG.secrets.keys];

/** Ключ каталога: латиница, дефисы и хотя бы одна точка. Домены в справке в кавычки не берутся — иначе это «ключ». */
const KEY_SHAPE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/** Обращение на «ты» во всех формах: `\b` в JS не знает кириллицу, поэтому границы слова — через Unicode. */
const INFORMAL = /(?<![\p{L}\p{N}_])(ты|тебе|тебя|тобой|твой|твоя|твоё|твое|твои|твоих|твоей|твоему|твою|твоим|твоими|твоём)(?![\p{L}\p{N}_])/iu;

function textsOfBlock(block: GuideBlock): string[] {
  switch (block.kind) {
    case "paragraph":
      return [block.text];
    case "list":
      return [...(block.title === undefined ? [] : [block.title]), ...block.items.map((item) => (typeof item === "string" ? item : item.text))];
    case "table":
      return [...block.head, ...block.rows.flat()];
  }
}

function textsOf(section: GuideSection): string[] {
  return [section.title, ...section.blocks.flatMap(textsOfBlock)];
}

function sectionById(id: string): GuideSection {
  const section = LINKS_GUIDE.find((item) => item.id === id);
  if (section === undefined) throw new Error(`В справке нет раздела ${id}`);
  return section;
}

/** Код в обратных кавычках: нечётные части текста, разрезанного по ней. */
function codeSpans(text: string): string[] {
  return text.split("`").filter((_, index) => index % 2 === 1);
}

describe("справка по ссылкам: форма", () => {
  it("разделов восемь, и идут они в порядке решения 4", () => {
    expect(LINKS_GUIDE.map((section) => section.id)).toEqual(SECTION_IDS);
  });

  it("id уникальны и годятся для якоря", () => {
    const ids = LINKS_GUIDE.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z-]+$/);
  });

  it("ни раздел, ни блок, ни ячейка не пусты", () => {
    for (const section of LINKS_GUIDE) {
      expect(section.title.trim(), section.id).not.toBe("");
      expect(section.blocks.length, section.id).toBeGreaterThan(0);
      for (const block of section.blocks) {
        const texts = textsOfBlock(block);
        expect(texts.length, `${section.id}: ${block.kind}`).toBeGreaterThan(0);
        for (const text of texts) {
          expect(text.trim(), `${section.id}: пустой текст`).not.toBe("");
          expect(text, `${section.id}: пробелы по краям «${text}»`).toBe(text.trim());
        }
      }
    }
  });

  it("у таблиц число ячеек в строке равно числу заголовков", () => {
    for (const section of LINKS_GUIDE) {
      for (const block of section.blocks) {
        if (block.kind !== "table") continue;
        expect(block.head.length, section.id).toBeGreaterThan(0);
        expect(block.rows.length, section.id).toBeGreaterThan(0);
        for (const row of block.rows) expect(row.length, `${section.id}: строка «${row[0] ?? ""}»`).toBe(block.head.length);
      }
    }
  });

  it("у ссылок в списках адрес https", () => {
    for (const section of LINKS_GUIDE) {
      for (const block of section.blocks) {
        if (block.kind !== "list") continue;
        for (const item of block.items) {
          if (typeof item !== "string") expect(item.href, section.id).toMatch(/^https:\/\//);
        }
      }
    }
  });
});

describe("справка по ссылкам: ключи каталогов", () => {
  it("каждый ключ в обратных кавычках есть в фикстуре", () => {
    for (const section of LINKS_GUIDE) {
      for (const text of textsOf(section)) {
        for (const span of codeSpans(text)) {
          if (KEY_SHAPE.test(span)) expect(FIXTURE_KEYS, `${section.id}: ключ ${span}`).toContain(span);
        }
      }
    }
  });

  it("раздел ключей перечисляет каждый ключ, влияющий на ссылки, строкой вида «ключ.с-точками»", () => {
    const spans = textsOf(sectionById("keys")).flatMap(codeSpans);
    for (const key of AFFECTS_LINKS) expect(spans, key).toContain(key);
  });

  it("фикстура не врёт: каждый её ключ есть в исходнике своего каталога", () => {
    for (const { file, keys } of Object.values(CATALOG)) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      for (const key of keys) expect(source, `${key} в ${file}`).toContain(`"${key}"`);
    }
  });

  it("ключи из справки сходятся с фикстурой в обе стороны", () => {
    const mentioned = new Set(LINKS_GUIDE.flatMap(textsOf).flatMap(codeSpans).filter((span) => KEY_SHAPE.test(span)));
    for (const key of FIXTURE_KEYS) expect(mentioned.has(key), `ключ ${key} из фикстуры не упомянут в справке`).toBe(true);
  });
});

describe("справка по ссылкам: язык", () => {
  it("к команде обращаются безлично или на «вы»: слов «ты», «тебе», «твой» нет", () => {
    for (const section of LINKS_GUIDE) {
      for (const text of textsOf(section)) expect(INFORMAL.test(text), `${section.id}: «${text.slice(0, 60)}…»`).toBe(false);
    }
  });

  it("проверка «ты» ловит то, что должна, и не трогает чужие слова", () => {
    expect(INFORMAL.test("Проверь, что ты нажал")).toBe(true);
    expect(INFORMAL.test("Это твой адрес")).toBe(true);
    expect(INFORMAL.test("Тебе пригодится")).toBe(true);
    expect(INFORMAL.test("Метры, мосты и квартиры")).toBe(false);
    expect(INFORMAL.test("Проверьте адрес")).toBe(false);
  });
});
