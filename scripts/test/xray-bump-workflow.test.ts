import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Workflow обновления ядра Xray (docs/35-stage4-plan.md Р202, tasks/T-0417):
// живьём его локально не запустить, поэтому важное закреплено проверкой текста.
// YAML-парсера в зависимостях нет — файлы читаются текстом.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// На Windows рабочая копия может быть с CRLF.
function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
}
const bump = read(".github/workflows/xray-bump.yml");
const ci = read(".github/workflows/ci.yml");
const target = read("backend/api/src/modules/proxies/xray-core/xray-core-target.ts");

/** Текст без строк-комментариев: слова из шапки не должны сбивать порядок шагов. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const bumpCode = code(bump);

/** Блок верхнего уровня: от `name:` до следующей строки без отступа. */
function topLevel(text: string, key: string): string {
  const match = new RegExp(`^${key}:\\n((?: {2}.*\\n|\\n)*)`, "m").exec(text);
  return match?.[1] ?? "";
}

describe("xray-bump.yml: запуск и права", () => {
  it("запуск — только workflow_dispatch с обязательным входом version", () => {
    const on = topLevel(bumpCode, "on");
    expect(on).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}version:\n(?: {8}.*\n)*? {8}required: true\n/m);
    expect(on).toMatch(/ {8}type: string\n/);
    for (const trigger of ["push", "pull_request", "schedule", "pull_request_target", "workflow_run"]) {
      expect(on).not.toMatch(new RegExp(`^ {2}${trigger}:`, "m"));
    }
    expect(on.match(/^ {2}[a-z_]+:/gm)).toEqual(["  workflow_dispatch:"]);
  });

  it("права — ровно contents: write и pull-requests: write", () => {
    const lines = topLevel(bumpCode, "permissions")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.trim());
    expect(lines.sort()).toEqual(["contents: write", "pull-requests: write"]);
  });

  it("повторные запуски встают в очередь, а не отменяют друг друга", () => {
    const block = topLevel(bumpCode, "concurrency");
    expect(block).toContain("group: xray-bump");
    expect(block).toContain("cancel-in-progress: false");
  });

  it("секретов в workflow нет: PR делает токен workflow", () => {
    expect(bumpCode).not.toContain("secrets.");
    expect(bumpCode).toContain("github.token");
  });
});

describe("xray-bump.yml: недоверенный вход", () => {
  it("`${{ inputs.` — только в run-name и в env: шага", () => {
    const lines = bumpCode.split("\n");
    const hits = lines.filter((line) => line.includes("${{ inputs."));
    expect(hits.length).toBeGreaterThan(0);
    for (const line of hits) {
      expect(line.trim().startsWith("run-name:") || /^ +[A-Z_]+: \$\{\{ inputs\.version \}\}$/.test(line)).toBe(true);
    }
  });

  it("в тексте run: подстановок `${{ ... }}` с входом нет", () => {
    // Многострочный и однострочный run: считаем блоком, пока отступ глубже ключа.
    const lines = bumpCode.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^( *)(?:- )?run: ?(.*)$/.exec(lines[index] ?? "");
      if (!match) continue;
      const indent = (match[1] ?? "").length;
      const body = [match[2] ?? ""];
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next] ?? "";
        if (line.trim() !== "" && line.length - line.trimStart().length <= indent) break;
        body.push(line);
      }
      expect(body.join("\n")).not.toMatch(/\$\{\{\s*inputs\./);
    }
  });

  it("версия проверяется раньше любого gh api, docker и git push", () => {
    const check = bumpCode.indexOf("xray-bump.mjs check-version");
    expect(check).toBeGreaterThan(-1);
    for (const action of ["gh api", "docker", "git push", "gh pr"]) {
      const at = bumpCode.indexOf(action);
      expect(at, action).toBeGreaterThan(check);
    }
  });
});

describe("xray-bump.yml: шаги", () => {
  it("проверка конфига есть и не глушится", () => {
    expect(bumpCode).toContain("bash infra/prod/xray/check-config.sh");
    expect(bumpCode).not.toContain("continue-on-error");
  });

  it("PR — в dev, с меткой release: patch, черновиком при провале проверки", () => {
    expect(bumpCode).toContain("gh pr create");
    expect(bumpCode).toContain("--base dev");
    expect(bumpCode).toContain('--label "release: patch"');
    expect(bumpCode).toContain("--draft");
  });

  it("повтор не плодит PR: ищется открытый PR из той же ветки", () => {
    expect(bumpCode).toContain("gh pr list");
    expect(bumpCode).toContain("--state open");
  });

  it("версия правится скриптом, а не sed", () => {
    expect(bumpCode).toContain("xray-bump.mjs apply");
    expect(bumpCode).not.toMatch(/\bsed\b/);
  });

  it("последний шаг роняет запуск, когда проверка конфига не прошла", () => {
    const last = bumpCode.slice(bumpCode.lastIndexOf("- name:"));
    expect(last).toContain("steps.check.outputs.ok != 'true'");
    expect(last).toContain("exit 1");
  });

  it("автор коммита — бот workflow", () => {
    expect(bumpCode).toContain("github-actions[bot]");
    expect(bumpCode).toContain("41898283+github-actions[bot]@users.noreply.github.com");
  });

  it("checkout — ветка dev", () => {
    expect(bumpCode).toMatch(/ref: dev\n/);
  });
});

describe("xray-bump.yml и сервер", () => {
  it("сервер запускает именно этот файл и эту ветку", () => {
    const workflow = /workflow: "([^"]+)"/.exec(target)?.[1];
    const ref = /ref: "([^"]+)"/.exec(target)?.[1];
    expect(workflow).toBe("xray-bump.yml");
    expect(ref).toBe("dev");
    expect(readFileSync(join(ROOT, ".github/workflows", workflow ?? "-"), "utf8")).toBeTruthy();
    expect(bumpCode).toMatch(new RegExp(`ref: ${ref}\\n`));
  });
});

describe("ci.yml: джоб xray-config", () => {
  const start = ci.indexOf("\n  xray-config:\n");
  const next = ci.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  const job = start === -1 ? "" : ci.slice(start, next === -1 ? undefined : start + 1 + next);

  it("есть и идёт только на pull_request", () => {
    expect(start).toBeGreaterThan(-1);
    expect(job).toContain("if: github.event_name == 'pull_request'");
  });

  it("смотрит на пути образа Xray и proxy-kit и запускает check-config.sh", () => {
    expect(job).toContain("infra/prod/xray/");
    expect(job).toContain("packages/proxy-kit/");
    expect(job).toContain("bash infra/prod/xray/check-config.sh");
    expect(job).toContain("fetch-depth: 0");
  });

  it("`${{ github.base_ref }}` — только в env:, права — общие (contents: read)", () => {
    for (const line of ci.split("\n").filter((text) => text.includes("github.base_ref"))) {
      expect(line).toMatch(/^ +BASE_REF: \$\{\{ github\.base_ref \}\}$/);
    }
    expect(job).not.toMatch(/^ {4}permissions:/m);
    expect(ci).toMatch(/^permissions:\n {2}contents: read\n/m);
  });
});
