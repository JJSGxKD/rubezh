import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { bumpVersion, compareReleaseLevels, formatVersion, parseStableTag } from "../release/semver.mjs";

describe("разбор и сравнение SemVer", () => {
  it("разбирает стабильный тег vX.Y.Z", () => {
    expect(parseStableTag("v1.4.2")).toEqual({ major: 1, minor: 4, patch: 2 });
  });

  it("отклоняет предрелизы и мусор", () => {
    expect(parseStableTag("v1.4.2-rc.3")).toBeNull();
    expect(parseStableTag("1.4.2")).toBeNull();
    expect(parseStableTag("latest")).toBeNull();
  });

  it("форматирует версию с ведущей v", () => {
    expect(formatVersion({ major: 0, minor: 5, patch: 0 })).toBe("v0.5.0");
  });

  it("сравнивает уровни релиза по порядку none < patch < minor < major", () => {
    expect(compareReleaseLevels("patch", "minor")).toBeLessThan(0);
    expect(compareReleaseLevels("major", "none")).toBeGreaterThan(0);
    expect(compareReleaseLevels("minor", "minor")).toBe(0);
  });
});

describe("bumpVersion", () => {
  it("поднимает патч, минор и мажор от 1.4.2", () => {
    const base = { major: 1, minor: 4, patch: 2 };
    expect(bumpVersion(base, "patch")).toEqual({ major: 1, minor: 4, patch: 3 });
    expect(bumpVersion(base, "minor")).toEqual({ major: 1, minor: 5, patch: 0 });
    expect(bumpVersion(base, "major")).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  it("сбрасывает младшие разряды при мажорном и минорном апдейте", () => {
    const base = { major: 0, minor: 4, patch: 2 };
    expect(bumpVersion(base, "minor")).toEqual({ major: 0, minor: 5, patch: 0 });
  });

  it("запрещает major до 1.0.0", () => {
    const base = { major: 0, minor: 4, patch: 2 };
    expect(() => bumpVersion(base, "major")).toThrow(/запрещена до 1\.0\.0/);
  });

  it("release: none не поднимает версию", () => {
    expect(bumpVersion({ major: 0, minor: 4, patch: 2 }, "none")).toBeNull();
  });
});
