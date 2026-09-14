import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { checkDocs, codePath, findLinkProblems } from "../docs-check.mjs";

// Ссылки в документации (docs/15-engineering-standards.md §11): документ,
// ведущий на удалённый файл, хуже отсутствующего.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("проверка ссылок в документации", () => {
  it("в документах репозитория нет битых ссылок на файлы и документы", () => {
    expect(checkDocs(ROOT).errors).toEqual([]);
  });

  it("находит битую ссылку markdown и несуществующий документ", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-check-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "01-real.md"), "# есть");
    const text = "См. [план](02-missing.md) и 01-real.md, а ещё 03-gone.md.\n```\n04-in-code.md\n```";

    const problems = findLinkProblems(text, join(root, "docs"), root, new Set(["01-real.md"]));
    expect(problems.map((problem: { message: string }) => problem.message)).toEqual([
      "ссылка ведёт на несуществующий файл: 02-missing.md",
      "нет такого документа: 02-missing.md",
      "нет такого документа: 03-gone.md",
    ]);
  });

  it("путь к коду — только из известных корней и без шаблонов", () => {
    expect(codePath("packages/app-shell/src/state/run.ts → AUTOSAVE_SEC")).toBe("packages/app-shell/src/state/run.ts");
    expect(codePath("packages/core-game/src/content/*")).toBeNull();
    expect(codePath("bh.meta.v1.profile")).toBeNull();
    expect(codePath("apps/web-*/vite.config.ts")).toBeNull();
  });
});
