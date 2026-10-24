import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { checkSummary, checkRunnerLines, checkTaskLine, checkTrailers, evaluateReleaseLabels, hasBreakingSection, minimumReleaseLevel, parsePrTitle, requiresBreakingSection } from "../release/pr-check.mjs";

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

describe("checkSummary", () => {
  const body = (summary: string) => `Задача: tasks/T-0001-x.md\n\n## Сводка для команды\n\n${summary}\n\n## Пост в канал\n\nтекст`;

  it("принимает сводку с номером этого PR в заголовке", () => {
    expect(checkSummary(body("📋 **СВОДКА: В DEV ВЛИТ PR #123 — ТЕКСТ**\n\nОписание"), 123)).toEqual([]);
  });

  it("отклоняет сводку без номера", () => {
    expect(checkSummary(body("📋 **СВОДКА: В DEV ВЛИТ PR — ТЕКСТ**"), 123)).toHaveLength(1);
  });

  it("отклоняет чужой номер", () => {
    expect(checkSummary(body("📋 **СВОДКА: В DEV ВЛИТ PR #99 — ТЕКСТ**"), 123)).toHaveLength(1);
  });

  it("не принимает #1234 за #123", () => {
    expect(checkSummary(body("📋 **СВОДКА: PR #1234 — ТЕКСТ**"), 123)).toHaveLength(1);
  });

  it.each(["#<номер>", "#НОМЕР"])("отклоняет заглушку %s с подсказкой", (stub) => {
    const errors = checkSummary(body(`📋 **СВОДКА: В DEV ВЛИТ PR ${stub} — ТЕКСТ**`), 123);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("впишите номер PR");
  });

  it("отклоняет раздел в блоке кода", () => {
    const errors = checkSummary(body("```\n📋 **СВОДКА: В DEV ВЛИТ PR #123 — ТЕКСТ**\n```"), 123);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("блоке кода");
  });

  it("отклоняет описание без раздела", () => {
    expect(checkSummary("Задача: tasks/T-0001-x.md", 123)).toHaveLength(1);
    expect(checkSummary("", 123)).toHaveLength(1);
  });
});

describe("checkTaskLine", () => {
  const files = ["T-0042-wipe.md", "T-0043-other.md"];

  it("принимает верную строку и существующий файл", () => {
    expect(checkTaskLine("Задача: tasks/T-0042-wipe.md\n\nтекст", "task/T-0042", files)).toEqual([]);
  });

  it("архивный путь принимается, когда файл лежит в архиве ветки (T-0204)", () => {
    const archived = ["archive/T-0042-wipe.md", "T-0043-other.md"];
    expect(checkTaskLine("Задача: tasks/archive/T-0042-wipe.md", "task/T-0042", archived)).toEqual([]);
  });

  it("путь верхней папки принимается, пока файл наверху; путь, которого нет ни там ни там, — ошибка", () => {
    expect(checkTaskLine("Задача: tasks/T-0043-other.md", "task/T-0043", files)).toEqual([]);
    expect(checkTaskLine("Задача: tasks/archive/T-0042-wipe.md", "task/T-0042", files)).toHaveLength(1);
    expect(checkTaskLine("Задача: tasks/T-0042-wipe.md", "task/T-0042", ["archive/T-0042-wipe.md"])).toHaveLength(1);
  });

  it("отклоняет несуществующий файл", () => {
    expect(checkTaskLine("Задача: tasks/T-0042-nope.md", "task/T-0042", files)).toHaveLength(1);
  });

  it("отклоняет чужой id в строке", () => {
    expect(checkTaskLine("Задача: tasks/T-0043-other.md", "task/T-0042", files)).toHaveLength(1);
  });

  it("отклоняет описание без строки «Задача:» первой", () => {
    expect(checkTaskLine("текст\nЗадача: tasks/T-0042-wipe.md", "task/T-0042", files)).toHaveLength(1);
    expect(checkTaskLine("", "task/T-0042", files)).toHaveLength(1);
  });

  it("не проверяет ветки не из task/*", () => {
    expect(checkTaskLine("", "feat/anything", files)).toEqual([]);
    expect(checkTaskLine("", "task/not-an-id", files)).toEqual([]);
  });
});

describe("checkTrailers", () => {
  const trailer = "Co-Authored-By: Claude <noreply@anthropic.com>";

  it("принимает трейлер после пустой строки", () => {
    expect(checkTrailers([{ sha: "a".repeat(40), message: `Заголовок\n\nТекст\n\n${trailer}\n` }])).toEqual([]);
    expect(checkTrailers([{ sha: "a".repeat(40), message: `Заголовок\n\n${trailer}\n` }])).toEqual([]);
  });

  it("отклоняет трейлер сразу под заголовком и называет короткий sha", () => {
    const errors = checkTrailers([{ sha: "abcdef0123456789".repeat(2) + "abcdef01", message: `Заголовок\n${trailer}\n` }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("abcdef0");
    expect(errors[0]).not.toContain("abcdef01234");
  });

  it("пропускает коммиты без трейлера", () => {
    expect(checkTrailers([{ sha: "b".repeat(40), message: "Заголовок\nбез трейлера\n" }])).toEqual([]);
  });
});

describe("checkRunnerLines", () => {
  const TASK = "Задача: tasks/T-0001-wipe.md";
  const OK = "Поток: claude-3 / sonnet-5.5 / medium\nЗапустил: владелец";

  it("ветка задачи с обеими верными строками — ошибок нет", () => {
    expect(checkRunnerLines(`${TASK}\n\n${OK}`, "task/T-0001")).toEqual([]);
  });

  it("помощник с ником из букв, цифр и подчёркивания — ошибок нет", () => {
    expect(checkRunnerLines(`${TASK}\n\nПоток: claude-3 / sonnet-5.5 / medium\nЗапустил: помощник ivan_2`, "task/T-0001")).toEqual([]);
  });

  it("ник с @ — ошибка", () => {
    expect(checkRunnerLines(`${TASK}\n\nПоток: claude-3 / sonnet-5.5 / medium\nЗапустил: помощник @ivan`, "task/T-0001")).toEqual([
      expect.stringContaining("запустил: в описании нет строки"),
    ]);
  });

  it("помощник без ника — ошибка", () => {
    expect(checkRunnerLines(`${TASK}\n\nПоток: claude-3 / sonnet-5.5 / medium\nЗапустил: помощник`, "task/T-0001")).toEqual([
      expect.stringContaining("запустил: в описании нет строки"),
    ]);
  });

  it("нет строки «Запустил» — ошибка", () => {
    expect(checkRunnerLines(`${TASK}\n\nПоток: claude-3 / sonnet-5.5 / medium`, "task/T-0001")).toEqual([
      expect.stringContaining("запустил: в описании нет строки"),
    ]);
  });

  it("нет строки «Поток» — ошибка «поток: в описании нет строки»", () => {
    expect(checkRunnerLines(`${TASK}\n\nЗапустил: владелец`, "task/T-0001")).toEqual([
      expect.stringContaining("поток: в описании нет строки"),
    ]);
  });

  it("модель не из списка — ошибка", () => {
    expect(checkRunnerLines(`${TASK}\n\nПоток: claude-3 / gpt-5 / medium\nЗапустил: владелец`, "task/T-0001")).toEqual([
      expect.stringContaining("модель или уровень не из списка"),
    ]);
  });

  it("номер аккаунта не цифры — ошибка", () => {
    expect(checkRunnerLines(`${TASK}\n\nПоток: claude-x / sonnet-5.5 / medium\nЗапустил: владелец`, "task/T-0001")).toEqual([
      expect.stringContaining("поток: в описании нет строки"),
    ]);
  });

  it("строка «Поток» внутри абзаца, не с начала строки, — как отсутствие", () => {
    expect(checkRunnerLines(`${TASK}\n\nРабота шла так. Поток: claude-3 / sonnet-5.5 / medium\nЗапустил: владелец`, "task/T-0001")).toEqual([
      expect.stringContaining("поток: в описании нет строки"),
    ]);
  });

  it("ветка не задачи — ошибок нет даже без строк", () => {
    expect(checkRunnerLines("", "lead/specs")).toEqual([]);
  });
});
