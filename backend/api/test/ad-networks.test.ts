import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AD_FORMATS,
  AD_NETWORK_PROFILES,
  PLACE_FORMAT,
  blockShapeProblem,
  keysProblem,
  missingKeys,
  placesOf,
  profileOf,
  type AdField,
} from "../src/modules/ads/ad-networks.js";
import { AD_PLACES, AD_SUCCESS } from "../src/modules/ads/ads-rules.js";
import { servable } from "../src/modules/ads/ads.service.js";
import { NETWORK_KEYS } from "./helpers/memory-ads.js";

// Профили рекламных сетей (docs/35-stage4-plan.md WP12, часть 5): по ним
// панель строит формы, сервер проверяет ключи и блоки, выдача отдаёт SDK то,
// что он ждёт. Профиль, который сам себе противоречит, — форма, которую
// нельзя заполнить.

const fields = AD_NETWORK_PROFILES.flatMap((profile) => [
  ...profile.keys.map((field): [string, AdField] => [`${profile.key}.${field.key}`, field]),
  ...profile.formats.flatMap((support) => (support.unit === null ? [] : [[`${profile.key}.${support.format}`, support.unit] as [string, AdField]])),
]);

describe("профили рекламных сетей", () => {
  it("шаблоны — целиком от начала до конца, пример проходит свой шаблон, пробел и пустое — нет", () => {
    for (const [path, field] of fields) {
      expect(field.pattern.startsWith("^") && field.pattern.endsWith("$"), path).toBe(true);
      const pattern = new RegExp(field.pattern);
      expect(pattern.test(field.example), `${path}: ${field.example}`).toBe(true);
      expect(pattern.test(""), path).toBe(false);
      expect(pattern.test(` ${field.example}`), path).toBe(false);
      expect(field.title.trim(), path).not.toBe("");
      expect(field.hint.trim(), path).not.toBe("");
    }
  });

  it("выбор из списка: каждое значение проходит шаблон, пример — одно из значений, лишнее — нет", () => {
    const choices = fields.filter(([, field]) => field.options !== undefined);
    expect(choices.map(([path]) => path)).toEqual(["taddy.task"]);
    for (const [path, field] of choices) {
      const values = field.options?.map((option) => option.value) ?? [];
      for (const value of values) expect(new RegExp(field.pattern).test(value), `${path}: ${value}`).toBe(true);
      expect(values, path).toContain(field.example);
      expect(new RegExp(field.pattern).test("feed"), path).toBe(false);
    }
  });

  it("у сети формат один раз, условия успеха — известные и не пустые, ключи не повторяются", () => {
    expect(new Set(AD_NETWORK_PROFILES.map((profile) => profile.key)).size).toBe(AD_NETWORK_PROFILES.length);
    for (const profile of AD_NETWORK_PROFILES) {
      const formats = profile.formats.map((support) => support.format);
      expect(new Set(formats).size, profile.key).toBe(formats.length);
      for (const format of formats) expect(AD_FORMATS, profile.key).toContain(format);
      for (const support of profile.formats) {
        expect(support.success.length, `${profile.key}.${support.format}`).toBeGreaterThan(0);
        for (const success of support.success) expect(AD_SUCCESS).toContain(success);
      }
      const keys = profile.keys.map((field) => field.key);
      expect(new Set(keys).size, profile.key).toBe(keys.length);
      expect(profile.cabinet === null || profile.cabinet.startsWith("https://"), profile.key).toBe(true);
    }
  });

  it("за награду — только показ до конца, межстраничная — показ, задание — целевое действие, подтверждённое сетью", () => {
    for (const profile of AD_NETWORK_PROFILES) {
      for (const support of profile.formats) {
        const expected = support.format === "task" ? ["cpa"] : ["view"];
        expect(support.success, `${profile.key}.${support.format}`).toEqual(expected);
      }
    }
  });

  it("каждое место закрывают хотя бы две сети — отказ одной не оставит его пустым (критерий WP12)", () => {
    for (const place of AD_PLACES) {
      const networks = AD_NETWORK_PROFILES.filter((profile) => placesOf(profile, [place]).length > 0).map((profile) => profile.key);
      expect(networks.length, `${place}: ${networks.join(", ")}`).toBeGreaterThanOrEqual(2);
    }
    expect(Object.keys(PLACE_FORMAT).sort()).toEqual([...AD_PLACES].sort());
  });

  it("профили — ровно те сети, что заведены миграцией: сеть без профиля в панели не настроить", () => {
    const sql = readFileSync(new URL("../prisma/migrations/20260930105150_ads/migration.sql", import.meta.url), "utf8");
    const seeded = [...sql.matchAll(/\('([a-z]+)', '[^']+', false, \d+, now\(\)\)/g)].map((match) => match[1]);
    expect(seeded.sort()).toEqual(AD_NETWORK_PROFILES.map((profile) => profile.key).sort());
  });

  it("ключи сети: незнакомый, не того вида — отказ; пустой — его нет, и включить сеть нельзя", () => {
    const richads = profileOf("richads");
    if (richads === undefined) throw new Error("нет профиля RichAds");
    expect(keysProblem(richads, { pubId: "792361", appId: "1396" })).toBeNull();
    expect(keysProblem(richads, { pubId: "pub-1" })).toMatch(/Publisher ID/);
    expect(keysProblem(richads, { secret: "1" })).toMatch(/нет ключа «secret»/);
    expect(missingKeys(richads, { pubId: "792361", appId: "" })).toEqual(["App ID (appId)"]);
    expect(missingKeys(richads, {})).toHaveLength(2);
  });

  it("блок по профилю: задание AdsGram на крутку колеса не встаёт и объясняет почему", () => {
    expect(blockShapeProblem({ networkKey: "adsgram", place: "wheel_spin", externalId: "task-1", success: "view" })).toBe("AdsGram: Block ID для этого места выглядит как «12345»");
    expect(blockShapeProblem({ networkKey: "richads", place: "task", externalId: null, success: "cpa" })).toBe(
      "RichAds не показывает в месте «Задания»: месту нужен формат «задание сети», а у сети его нет",
    );
    expect(blockShapeProblem({ networkKey: "adsgram", place: "task", externalId: "task-1", success: "view" })).toBe("AdsGram: в этом месте успех — целевое действие");
    expect(blockShapeProblem({ networkKey: "monetag", place: "task", externalId: null, success: "cpa" })).toMatch(/нет в коде/);
    expect(blockShapeProblem({ networkKey: "taddy", place: "wheel_spin", externalId: "x", success: "view" })).toMatch(/нет блока в кабинете/);
  });

  it("выдача показывает только то, что SDK сможет показать: блок по профилю и сеть с ключами", () => {
    const block = { networkKey: "richads", place: "interstitial" as const, externalId: null, success: "view" as const };
    expect(servable({ ...block, networkKeys: NETWORK_KEYS.richads ?? {} })).toBe(true);
    expect(servable({ ...block, networkKeys: { pubId: "792361" } })).toBe(false);
    expect(servable({ ...block, networkKeys: { pubId: "792361", appId: "app" } })).toBe(false);
    expect(servable({ ...block, externalId: "123", networkKeys: NETWORK_KEYS.richads ?? {} })).toBe(false);
    expect(servable({ networkKey: "adsgram", place: "wheel_spin", externalId: "123", success: "view", networkKeys: {} })).toBe(true);
  });
});
