import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита сопровождения на чистом JS, типов у неё нет и не нужно
import { bumpCoreMax, bumpDockerfile, branchOf, currentVersion, prBody, titleOf, DIGEST_RE, VERSION_RE } from "../ops/xray-bump.mjs";

// Правка версии ядра Xray скриптом (docs/35-stage4-plan.md Р202, tasks/T-0417):
// ровно две строки в двух файлах, всё остальное как было. Файлы читаются с
// диска: тест падает, если кто-то изменит вид строки, на который опирается скрипт.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const dockerfile = readFileSync(join(ROOT, "infra/prod/xray/Dockerfile"), "utf8");
const coreSource = readFileSync(join(ROOT, "packages/proxy-kit/src/xray-core.ts"), "utf8");

const DIGEST = `sha256:${"a".repeat(64)}`;
const FROM_LINE = /^FROM ghcr\.io\/xtls\/xray-core:.*$/m;

function otherLines(text: string, pattern: RegExp): string[] {
  return text.split("\n").filter((line) => !pattern.test(line));
}

describe("имена ветки и заголовка", () => {
  it("ветка и заголовок по версии", () => {
    expect(branchOf("26.11.5")).toBe("chore/xray-core-26.11.5");
    expect(titleOf("26.11.5")).toBe("chore(infra): Обнови ядро Xray до 26.11.5");
  });

  it("версия не по форме — исключение", () => {
    expect(() => branchOf("26.11")).toThrow();
    expect(() => titleOf("v26.11.5")).toThrow();
  });
});

describe("bumpDockerfile", () => {
  it("меняет ровно строку FROM … AS xray, остальные — байт в байт", () => {
    const next = bumpDockerfile(dockerfile, "26.11.5", DIGEST);
    expect(next).toContain(`FROM ghcr.io/xtls/xray-core:26.11.5@${DIGEST} AS xray\n`);
    expect(otherLines(next, FROM_LINE)).toEqual(otherLines(dockerfile, FROM_LINE));
    expect(next.split("\n")).toHaveLength(dockerfile.split("\n").length);
  });

  it("CRLF остаётся CRLF", () => {
    const crlf = dockerfile.replace(/\n/g, "\r\n");
    const next = bumpDockerfile(crlf, "26.11.5", DIGEST);
    expect(next).toContain(`FROM ghcr.io/xtls/xray-core:26.11.5@${DIGEST} AS xray\r\n`);
    expect(next.replace(/\r\n/g, "")).not.toContain("\n");
    expect(next.replace(/\r\n/g, "\n")).toBe(bumpDockerfile(dockerfile, "26.11.5", DIGEST));
  });

  it("две строки FROM ghcr.io/xtls/xray-core — исключение", () => {
    expect(() => bumpDockerfile(`${dockerfile}\n${dockerfile.match(FROM_LINE)?.[0] ?? ""}\n`, "26.11.5", DIGEST)).toThrow();
  });

  it("нет строки FROM — исключение", () => {
    expect(() => bumpDockerfile("FROM alpine:3.24\n", "26.11.5", DIGEST)).toThrow();
  });

  it("версия и digest не по форме — исключение", () => {
    for (const version of ["26.11", "26.11.5; rm -rf /", "v26.11.5", ""]) {
      expect(() => bumpDockerfile(dockerfile, version, DIGEST)).toThrow();
    }
    for (const digest of ["sha256:abc", `sha256:${"A".repeat(64)}`, `${"a".repeat(64)}`, `sha256:${"a".repeat(64)}\nRUN x`]) {
      expect(() => bumpDockerfile(dockerfile, "26.11.5", digest)).toThrow();
    }
  });
});

describe("bumpCoreMax", () => {
  it("меняется только строка XRAY_CORE_MAX, XRAY_CORE_MIN прежний", () => {
    const next = bumpCoreMax(coreSource, "26.11.5");
    expect(next).toContain('export const XRAY_CORE_MAX = "26.11.5";\n');
    const min = /^export const XRAY_CORE_MIN = ".*";$/m;
    expect(next.match(min)?.[0]).toBe(coreSource.match(min)?.[0]);
    const max = /^export const XRAY_CORE_MAX = ".*";$/m;
    expect(otherLines(next, max)).toEqual(otherLines(coreSource, max));
  });

  it("CRLF остаётся CRLF", () => {
    const crlf = coreSource.replace(/\n/g, "\r\n");
    const next = bumpCoreMax(crlf, "26.11.5");
    expect(next.replace(/\r\n/g, "\n")).toBe(bumpCoreMax(coreSource, "26.11.5"));
    expect(next.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("нет строки или две — исключение", () => {
    expect(() => bumpCoreMax("export const XRAY_CORE_MIN = \"26.11.9\";\n", "26.11.5")).toThrow();
    expect(() => bumpCoreMax(`${coreSource}\nexport const XRAY_CORE_MAX = "1.2.3";\n`, "26.11.5")).toThrow();
  });

  it("версия не по форме — исключение", () => {
    for (const version of ["26.11", "26.11.5; rm -rf /", "v26.11.5", '26.11.5"; process.exit(1); "']) {
      expect(() => bumpCoreMax(coreSource, version)).toThrow();
    }
  });
});

describe("currentVersion и согласованность файлов", () => {
  it("версия из Dockerfile совпадает с XRAY_CORE_MAX", () => {
    const max = /^export const XRAY_CORE_MAX = "([0-9.]+)";$/m.exec(coreSource)?.[1];
    expect(currentVersion(dockerfile)).toBe(max);
  });

  it("нет строки или две — исключение", () => {
    expect(() => currentVersion("FROM alpine:3.24\n")).toThrow();
    expect(() => currentVersion(`${dockerfile}\n${dockerfile.match(FROM_LINE)?.[0] ?? ""}\n`)).toThrow();
  });

  it("регулярки форм строгие", () => {
    expect(VERSION_RE.test("26.11.5")).toBe(true);
    expect(VERSION_RE.test("26.11.5\n")).toBe(false);
    expect(DIGEST_RE.test(DIGEST)).toBe(true);
    expect(DIGEST_RE.test(`${DIGEST}\n`)).toBe(false);
  });
});

describe("prBody", () => {
  const base = { version: "26.11.5", previous: "26.11.9", digest: DIGEST, releaseUrl: "https://github.com/XTLS/Xray-core/releases/tag/v26.11.5", checkOk: true, checkLog: "всё хорошо", number: null };

  it("проверка прошла — галочка, без «черновиком»", () => {
    const body: string = prBody(base);
    expect(body).toContain("✅");
    expect(body).not.toContain("черновиком");
    expect(body).toContain("ghcr.io/xtls/xray-core:26.11.5@" + DIGEST);
    expect(body).toContain(base.releaseUrl);
  });

  it("проверка не прошла — черновик и куда смотреть", () => {
    const body: string = prBody({ ...base, checkOk: false });
    expect(body).toContain("❌");
    expect(body).toContain("черновиком");
    expect(body).toContain("xray-config.ts");
    expect(body).toContain("XRAY_CORE_BLOCKS");
  });

  it("лог из 200 строк — в описании 60 последних", () => {
    const log = Array.from({ length: 200 }, (_, index) => `строка ${index + 1}`).join("\n");
    const body: string = prBody({ ...base, checkLog: log });
    expect(body).toContain("строка 200");
    expect(body).toContain("строка 141");
    expect(body).not.toContain("строка 140\n");
    expect(body).not.toContain("строка 1\n");
  });

  it("лог с ограждением кода не ломает блок", () => {
    const body: string = prBody({ ...base, checkLog: "до\n```\nпосле" });
    const fences = body.match(/^```/gm) ?? [];
    expect(fences.length % 2).toBe(0);
  });

  it("номер: до создания PR — заглушка, после — число", () => {
    expect(prBody({ ...base, number: null })).toContain("#<номер>");
    const numbered: string = prBody({ ...base, number: 812 });
    expect(numbered).toContain("PR #812");
    expect(numbered).not.toContain("#<номер>");
  });

  it("структура: сводка для команды есть, «Для игроков» нет, переоткрытие названо", () => {
    const body: string = prBody(base);
    expect(body).toContain("## Сводка для команды");
    expect(body).not.toContain("## Для игроков");
    expect(body).toContain("закрыть и снова открыть PR");
    expect(body).toContain("📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОБНОВИ ЯДРО XRAY ДО 26.11.5**");
  });

  it("форма значений проверяется и здесь", () => {
    expect(() => prBody({ ...base, version: "26.11" })).toThrow();
    expect(() => prBody({ ...base, digest: "sha256:abc" })).toThrow();
    expect(() => prBody({ ...base, previous: "x" })).toThrow();
  });
});
