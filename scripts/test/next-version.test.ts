import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { nextVersion, releaseLevelForCommit } from "../release/next-version.mjs";

// Критерий приёмки WP9 (docs/26-stage2-plan.md): release: minor после мерджа
// даёт минорный тег; все release: none — без тега.

describe("nextVersion", () => {
  it("пустой диапазон коммитов — без тега", () => {
    expect(nextVersion("v0.4.2", [])).toBeNull();
  });

  it("все PR с release: none — без тега", () => {
    expect(nextVersion("v0.4.2", ["none", "none"])).toBeNull();
  });

  it("берёт максимум меток с базы, а не только последнюю", () => {
    expect(nextVersion("v0.4.2", ["patch", "minor", "none"])).toBe("v0.5.0");
  });

  it("release: major поднимает мажор после 1.0.0", () => {
    expect(nextVersion("v1.4.2", ["patch", "major"])).toBe("v2.0.0");
  });

  it("release: major до 1.0.0 — ошибка, а не молчаливый патч", () => {
    expect(() => nextVersion("v0.4.2", ["major"])).toThrow(/запрещена до 1\.0\.0/);
  });

  it("без базового тега считает от 0.0.0", () => {
    expect(nextVersion(null, ["patch"])).toBe("v0.0.1");
  });
});

describe("releaseLevelForCommit", () => {
  it("коммит без PR — ошибка", () => {
    expect(() => releaseLevelForCommit("abc123", [])).toThrow(/слит без PR/);
  });

  it("PR без метки release: * — ошибка", () => {
    const pr = { number: 42, labels: [{ name: "enhancement" }] };
    expect(() => releaseLevelForCommit("abc123", [pr])).toThrow(/без ровно одной метки/);
  });

  it("PR с двумя метками release: * — ошибка", () => {
    const pr = { number: 42, labels: [{ name: "release: minor" }, { name: "release: patch" }] };
    expect(() => releaseLevelForCommit("abc123", [pr])).toThrow(/без ровно одной метки/);
  });

  it("PR с одной валидной меткой — уровень возвращается", () => {
    const pr = { number: 42, labels: [{ name: "release: patch" }] };
    expect(releaseLevelForCommit("abc123", [pr])).toBe("patch");
  });
});
