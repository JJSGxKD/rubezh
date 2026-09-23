import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { checkPins, classifyUses, findUses, tagCommitFromLsRemote, verifyPins } from "../action-pins.mjs";

// Сторонние actions — только по SHA (docs/09-ci-cd.md §12): тег владелец
// action может перевесить на другой код, SHA — нет.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SHA = "11d5960a326750d5838078e36cf38b85af677262";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "action-pins-"));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

describe("actions в workflow репозитория", () => {
  it("все закреплены по SHA с версией в комментарии", () => {
    expect(checkPins(ROOT).errors).toEqual([]);
  });

  it("проверка действительно их видит, а не проходит по пустому списку", () => {
    const report = checkPins(ROOT);

    expect(report.files).toBeGreaterThan(0);
    expect(report.pins.map((pin: { repo: string }) => pin.repo)).toContain("actions/checkout");
  });
});

describe("classifyUses", () => {
  it("принимает полный SHA с версией и отделяет репозиторий", () => {
    expect(classifyUses(`actions/checkout@${SHA}`, "v4.4.0")).toEqual({
      kind: "pinned",
      repo: "actions/checkout",
      path: "actions/checkout",
      sha: SHA,
      version: "v4.4.0",
    });
  });

  it("у action из подкаталога и чужого переиспользуемого workflow репозиторий — первые два сегмента", () => {
    expect(classifyUses(`github/codeql-action/init@${SHA}`, "v3.28.0")).toMatchObject({
      kind: "pinned",
      repo: "github/codeql-action",
    });
    expect(classifyUses(`org/shared/.github/workflows/ci.yml@${SHA}`, "v1.0.0")).toMatchObject({
      kind: "pinned",
      repo: "org/shared",
    });
  });

  it("отклоняет плавающий тег, точную версию тегом и ветку", () => {
    for (const ref of ["actions/checkout@v4", "actions/checkout@v4.4.0", "actions/checkout@main"]) {
      expect(classifyUses(ref, "v4.4.0").kind).toBe("problem");
    }
  });

  it("отклоняет короткий SHA и SHA заглавными", () => {
    expect(classifyUses("actions/checkout@11d5960", "v4.4.0").kind).toBe("problem");
    expect(classifyUses(`actions/checkout@${SHA.toUpperCase()}`, "v4.4.0").kind).toBe("problem");
  });

  it("отклоняет ссылку вовсе без версии после @", () => {
    expect(classifyUses("actions/checkout", "").kind).toBe("problem");
  });

  it("требует версию комментарием, и полную: `# v4` не говорит, что закреплено", () => {
    expect(classifyUses(`actions/checkout@${SHA}`, "").kind).toBe("problem");
    expect(classifyUses(`actions/checkout@${SHA}`, "v4").kind).toBe("problem");
    expect(classifyUses(`actions/checkout@${SHA}`, "последняя").kind).toBe("problem");
  });

  it("пропускает локальные actions: они проходят ревью вместе с PR", () => {
    expect(classifyUses("./.github/actions/setup", "")).toEqual({ kind: "local" });
    expect(classifyUses("./.github/workflows/build.yml", "")).toEqual({ kind: "local" });
  });

  it("образ docker:// — только по digest", () => {
    expect(classifyUses("docker://alpine:3.20", "").kind).toBe("problem");
    expect(classifyUses(`docker://alpine@sha256:${"a".repeat(64)}`, "").kind).toBe("docker");
  });

  it("сообщение называет ссылку и показывает, как исправить", () => {
    const result = classifyUses("actions/setup-node@v4", "");

    expect(result.message).toContain("actions/setup-node@v4");
    expect(result.message).toContain("uses: actions/setup-node@<SHA> # v1.2.3");
  });
});

describe("findUses", () => {
  it("находит шаги и вызов переиспользуемого workflow, в кавычках и без", () => {
    const text = [
      "jobs:",
      "  call:",
      `    uses: org/shared/.github/workflows/ci.yml@${SHA} # v1.0.0`,
      "  build:",
      "    steps:",
      `      - uses: "actions/checkout@${SHA}" # v4.4.0`,
      "      - uses: 'actions/setup-node@v4'",
      "      - name: Сборка",
      "        uses: ./.github/actions/build",
    ].join("\n");

    expect(findUses(text)).toEqual({
      found: [
        { line: 3, ref: `org/shared/.github/workflows/ci.yml@${SHA}`, comment: "v1.0.0" },
        { line: 6, ref: `actions/checkout@${SHA}`, comment: "v4.4.0" },
        { line: 7, ref: "actions/setup-node@v4", comment: "" },
        { line: 9, ref: "./.github/actions/build", comment: "" },
      ],
      unparsed: [],
    });
  });

  it("не путает с `uses:` закомментированный шаг", () => {
    expect(findUses("      # - uses: actions/checkout@v4").found).toEqual([]);
  });

  it("строку, которую не разобрала, отдаёт отдельно, а не пропускает молча", () => {
    const text = ["      - { uses: actions/checkout@v4 }", '      - "uses": actions/checkout@v4'].join("\n");

    expect(findUses(text)).toEqual({ found: [], unparsed: [1, 2] });
  });

  it("не спотыкается о перевод строки CRLF", () => {
    expect(findUses(`      - uses: actions/checkout@${SHA} # v4.4.0\r\n`).found).toEqual([
      { line: 1, ref: `actions/checkout@${SHA}`, comment: "v4.4.0" },
    ]);
  });
});

describe("checkPins", () => {
  it("обходит все .yml и .yaml в .github, включая локальные actions, и называет файл и строку", () => {
    const root = fixture({
      ".github/workflows/ci.yml": `steps:\n  - uses: actions/checkout@${SHA} # v4.4.0\n  - uses: actions/setup-node@v4\n`,
      ".github/workflows/deploy.yaml": "steps:\n  - uses: appleboy/ssh-action@master\n",
      ".github/actions/setup/action.yml": "runs:\n  steps:\n    - { uses: pnpm/action-setup@v4 }\n",
      ".github/pull_request_template.md": "- uses: actions/checkout@v4\n",
    });

    const report = checkPins(root);

    expect(report.files).toBe(3);
    expect(report.pins).toEqual([
      {
        kind: "pinned",
        repo: "actions/checkout",
        path: "actions/checkout",
        sha: SHA,
        version: "v4.4.0",
        where: ".github/workflows/ci.yml:2",
      },
    ]);
    expect(report.errors.map((error: string) => error.split(" ")[0])).toEqual([
      ".github/actions/setup/action.yml:3",
      ".github/workflows/ci.yml:3",
      ".github/workflows/deploy.yaml:2",
    ]);
  });
});

// Сверка SHA с тегом идёт по сети в pr-checks.yml; здесь — логика решения
// с подставным источником тегов.
describe("verifyPins", () => {
  const OTHER = "34e114876b0b11c390a56381ad16ebd13914f8d5";

  function pin(where: string, sha = SHA, version = "v4.4.0") {
    return { kind: "pinned", repo: "actions/checkout", path: "actions/checkout", sha, version, where };
  }

  it("SHA, на который указывает тег из комментария, проходит", () => {
    expect(verifyPins([pin("ci.yml:58")], () => SHA)).toEqual([]);
  });

  it("SHA не от этой версии — ошибка с обоими SHA и местом в файле", () => {
    const [error] = verifyPins([pin("ci.yml:58", OTHER)], () => SHA);

    expect(error).toContain("ci.yml:58");
    expect(error).toContain(`указывает на ${SHA}`);
    expect(error).toContain(`закреплён ${OTHER}`);
  });

  it("тега из комментария в репозитории нет — ошибка, а не молчаливый пропуск", () => {
    expect(verifyPins([pin("ci.yml:58")], () => null)).toEqual([
      "ci.yml:58 в actions/checkout нет тега v4.4.0: версия в комментарии ничем не подтверждена",
    ]);
  });

  it("сбой при чтении тегов — ошибка на каждом месте, остальные actions всё равно сверяются", () => {
    const pins = [pin("ci.yml:58"), pin("ci.yml:92"), { ...pin("ci.yml:60"), repo: "pnpm/action-setup", sha: OTHER }];
    const resolve = (repo: string) => {
      if (repo === "actions/checkout") throw new Error("git ls-remote не ответил за 30 секунд");
      return OTHER;
    };

    expect(verifyPins(pins, resolve)).toEqual([
      "ci.yml:58 actions/checkout: не удалось прочитать теги, SHA не сверен — git ls-remote не ответил за 30 секунд",
      "ci.yml:92 actions/checkout: не удалось прочитать теги, SHA не сверен — git ls-remote не ответил за 30 секунд",
    ]);
  });

  it("одна пара «репозиторий + версия» спрашивается один раз, сколько бы шагов её ни использовали", () => {
    const asked: string[] = [];
    const resolve = (repo: string, version: string) => {
      asked.push(`${repo}@${version}`);
      return SHA;
    };

    verifyPins([pin("ci.yml:58"), pin("ci.yml:92"), pin("ci.yml:115"), pin("sync-dev.yml:26", SHA, "v4.3.1")], resolve);

    expect(asked).toEqual(["actions/checkout@v4.4.0", "actions/checkout@v4.3.1"]);
  });
});

describe("tagCommitFromLsRemote", () => {
  it("у аннотированного тега берёт коммит из строки ^{}, а не SHA объекта тега", () => {
    const output = [`c336a2788d9774dccfdeb4823a5058ccc9f07453\trefs/tags/v4.3.0`, `${SHA}\trefs/tags/v4.3.0^{}`].join("\n");

    expect(tagCommitFromLsRemote(output, "v4.3.0")).toBe(SHA);
  });

  it("у лёгкого тега строки ^{} нет — коммит в строке самого тега", () => {
    expect(tagCommitFromLsRemote(`${SHA}\trefs/tags/v4.4.0\n`, "v4.4.0")).toBe(SHA);
  });

  it("не принимает тег с похожим именем", () => {
    expect(tagCommitFromLsRemote(`${SHA}\trefs/tags/v4.4.0-beta\n`, "v4.4.0")).toBeNull();
  });

  it("пустой вывод — тега нет", () => {
    expect(tagCommitFromLsRemote("", "v4.4.0")).toBeNull();
  });

  it("не спотыкается о перевод строки CRLF", () => {
    expect(tagCommitFromLsRemote(`${SHA}\trefs/tags/v4.4.0\r\n`, "v4.4.0")).toBe(SHA);
  });
});
