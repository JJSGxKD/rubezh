import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { nextVersion, releaseLevelForCommit } from "../release/next-version.mjs";

// Критерий приёмки WP9 (docs/26-stage2-plan.md): release: minor после мерджа
// даёт минорный тег; все release: none — без тега.

const MERGED = "2026-09-20T10:00:00Z";

function pr(number: number, label: string | null, head = `feature-${number}`, base = "dev", mergedAt: string | null = MERGED) {
  return {
    number,
    merged_at: mergedAt,
    head: { ref: head },
    base: { ref: base },
    labels: label === null ? [] : [{ name: `release: ${label}` }],
  };
}

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

  it("коммит только в открытом PR — это прямой push, ошибка", () => {
    expect(() => releaseLevelForCommit("abc123", [pr(42, "minor", "feature", "main", null)])).toThrow(/слит без PR/);
  });

  it("PR без метки release: * — ошибка", () => {
    const unlabeled = { ...pr(42, null), labels: [{ name: "enhancement" }] };
    expect(() => releaseLevelForCommit("abc123", [unlabeled])).toThrow(/без ровно одной метки/);
  });

  it("PR с двумя метками release: * — ошибка", () => {
    const double = { ...pr(42, "minor"), labels: [{ name: "release: minor" }, { name: "release: patch" }] };
    expect(() => releaseLevelForCommit("abc123", [double])).toThrow(/без ровно одной метки/);
  });

  it("PR с одной валидной меткой — уровень возвращается", () => {
    expect(releaseLevelForCommit("abc123", [pr(42, "patch")])).toBe("patch");
  });

  it("коммит фичи в релизе dev → main берёт метку своего PR, а не релизного", () => {
    // GitHub связывает коммит и с PR фичи, и с релизным PR, в котором он приехал в main
    const feature = pr(42, "minor", "feature", "dev");
    const release = pr(50, null, "dev", "main");
    expect(releaseLevelForCommit("abc123", [release, feature])).toBe("minor");
  });

  it("merge-коммит релизного PR — none: номер уже вычислен предрелизами", () => {
    expect(releaseLevelForCommit("merge", [pr(50, null, "dev", "main")])).toBe("none");
  });

  it("merge-коммит синка main → dev — none: изменения уже выпущены в main", () => {
    expect(releaseLevelForCommit("merge", [pr(51, null, "main", "dev")])).toBe("none");
  });

  it("открытый стековый PR не влияет на версию того, что под ним", () => {
    // коммит из #39 GitHub связывает и с #39, и со стековым #40 поверх него
    const own = pr(39, "none", "docs/close-stage2", "main");
    const stackedOpen = pr(40, "minor", "docs/week-to-stage", "docs/close-stage2", null);
    expect(releaseLevelForCommit("abc123", [stackedOpen, own])).toBe("none");
  });

  it("несколько смерженных настоящих PR — максимум меток", () => {
    const own = pr(39, "patch", "a", "main");
    const stacked = pr(40, "minor", "b", "a");
    expect(releaseLevelForCommit("abc123", [own, stacked])).toBe("minor");
  });
});
