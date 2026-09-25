import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { evaluateReleaseLabels, hasBreakingSection, minimumReleaseLevel, parsePrTitle, requiresBreakingSection } from "../release/pr-check.mjs";

// Формат заголовка — CLAUDE.md, «Коммиты». Проверка PR — docs/09-ci-cd.md §8.1.

describe("parsePrTitle", () => {
  it("принимает валидный заголовок с scope", () => {
    const result = parsePrTitle("feat(core-game): Добавить паттерн поведения roaming");
    expect(result).toMatchObject({ valid: true, type: "feat", scope: "core-game", breaking: false });
  });

  it("принимает заголовок без scope", () => {
    expect(parsePrTitle("docs: Обновить схему ролей")).toMatchObject({ valid: true, type: "docs" });
  });

  it("распознаёт ! как ломающее изменение", () => {
    expect(parsePrTitle("feat(api)!: Сменить формат ответа")).toMatchObject({ valid: true, breaking: true });
  });

  it("отклоняет неизвестный тип", () => {
    expect(parsePrTitle("feature: Добавить экран").valid).toBe(false);
  });

  it("отклоняет заголовок без заглавной буквы", () => {
    expect(parsePrTitle("fix: исправить баг").valid).toBe(false);
  });

  it("отклоняет заголовок с точкой в конце", () => {
    expect(parsePrTitle("fix: Исправить баг.").valid).toBe(false);
  });

  it("отклоняет заголовок длиннее 72 символов", () => {
    const long = "fix: " + "Оченьдлинныйтекстбезпробеловкоторыйнеуместитсявсемидесятидвухсимволах";
    expect(parsePrTitle(long).valid).toBe(false);
  });
});

describe("minimumReleaseLevel", () => {
  it("feat — не ниже minor", () => {
    expect(minimumReleaseLevel({ type: "feat", breaking: false }, 0)).toBe("minor");
  });

  it("fix/perf/refactor/revert — не ниже patch", () => {
    for (const type of ["fix", "perf", "refactor", "revert"]) {
      expect(minimumReleaseLevel({ type, breaking: false }, 0)).toBe("patch");
    }
  });

  it("docs/style/test/chore/ci — любая метка", () => {
    for (const type of ["docs", "style", "test", "chore", "ci"]) {
      expect(minimumReleaseLevel({ type, breaking: false }, 0)).toBe("none");
    }
  });

  it("! до 1.0.0 — minor, после — major", () => {
    expect(minimumReleaseLevel({ type: "fix", breaking: true }, 0)).toBe("minor");
    expect(minimumReleaseLevel({ type: "fix", breaking: true }, 1)).toBe("major");
  });

  it("feat(dev), feat(ci), feat(infra) — хватает patch: до игрока это не доходит", () => {
    for (const scope of ["dev", "ci", "infra"]) {
      expect(minimumReleaseLevel({ type: "feat", scope, breaking: false }, 0)).toBe("patch");
    }
  });

  it("послабление только для своей области: feat в любой другой — по-прежнему minor", () => {
    for (const scope of ["core-game", "app-shell", "api", null]) {
      expect(minimumReleaseLevel({ type: "feat", scope, breaking: false }, 0)).toBe("minor");
    }
  });

  it("ломающее изменение послаблением не пользуется", () => {
    // `!` означает, что у кого-то ломается рабочий процесс, и номер версии
    // обязан это показать, в какой бы области изменение ни лежало.
    expect(minimumReleaseLevel({ type: "feat", scope: "dev", breaking: true }, 0)).toBe("minor");
    expect(minimumReleaseLevel({ type: "feat", scope: "dev", breaking: true }, 1)).toBe("major");
  });
});

describe("evaluateReleaseLabels", () => {
  it("метки нет — предлагает минимум", () => {
    expect(evaluateReleaseLabels([], "minor")).toEqual({ status: "missing", suggested: "minor" });
  });

  it("метка ниже минимума — ошибка (критерий приёмки WP9: feat с patch не проходит)", () => {
    expect(evaluateReleaseLabels(["release: patch"], "minor")).toMatchObject({ status: "too-low" });
  });

  it("метка не ниже минимума — ок, выше минимума тоже можно", () => {
    expect(evaluateReleaseLabels(["release: minor"], "minor")).toEqual({ status: "ok", label: "minor" });
    expect(evaluateReleaseLabels(["release: major"], "patch")).toMatchObject({ status: "ok", label: "major" });
  });

  it("две метки release: * — ошибка", () => {
    expect(evaluateReleaseLabels(["release: minor", "release: patch"], "none")).toMatchObject({
      status: "multiple",
    });
  });

  it("посторонние метки не мешают", () => {
    expect(evaluateReleaseLabels(["bug", "release: patch"], "patch")).toEqual({ status: "ok", label: "patch" });
  });
});

describe("requiresBreakingSection", () => {
  it("требуется при ! в заголовке или метке major", () => {
    expect(requiresBreakingSection({ breaking: true }, {})).toBe(true);
    expect(requiresBreakingSection({ breaking: false }, { label: "major" })).toBe(true);
    expect(requiresBreakingSection({ breaking: false }, { label: "minor" })).toBe(false);
  });
});

describe("hasBreakingSection", () => {
  it("пустой раздел с плейсхолдером не считается заполненным", () => {
    const body = "## Что ломается и как мигрировать\n\n<!-- обязательно для major -->\n\n## Другое\nтекст";
    expect(hasBreakingSection(body)).toBe(false);
  });

  it("заполненный раздел проходит", () => {
    const body = "## Что ломается и как мигрировать\n\nСтарые клиенты сломаются, план миграции ниже.\n\n## Другое";
    expect(hasBreakingSection(body)).toBe(true);
  });

  it("раздела нет вовсе", () => {
    expect(hasBreakingSection("## Что и почему\nтекст")).toBe(false);
  });
});
