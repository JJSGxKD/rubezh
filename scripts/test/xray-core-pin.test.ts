import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Версия ядра Xray (Р202): образ в Dockerfile и XRAY_CORE_MAX в proxy-kit
// меняются вместе, а статус ядра пишется в отдельный том. Файлы читаются текстом.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const dockerfile = read("infra/prod/xray/Dockerfile");
const core = read("packages/proxy-kit/src/xray-core.ts");
const compose = read("infra/prod/compose.yml");
const runSh = read("infra/prod/xray/run.sh");

/** Блок сервиса compose: от `  имя:` до следующего ключа на том же уровне. */
function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`сервис ${name} не найден в compose.yml`);
  const rest = compose.slice(start + 1);
  const next = /\n {2}\S|\n\S/.exec(rest.slice(rest.indexOf("\n") + 1));
  const body = rest.slice(rest.indexOf("\n") + 1);
  return next ? body.slice(0, next.index) : body;
}

describe("версия ядра Xray", () => {
  const fromLines = dockerfile.match(/^FROM ghcr\.io\/xtls\/xray-core:\d+\.\d+\.\d+@sha256:[0-9a-f]{64} AS xray$/gm) ?? [];
  const maxLines = core.match(/^export const XRAY_CORE_MAX = "\d+\.\d+\.\d+";$/gm) ?? [];

  it("в Dockerfile ровно одна строка образа с digest", () => {
    expect(fromLines).toHaveLength(1);
  });

  it("в xray-core.ts ровно одна строка XRAY_CORE_MAX в нужном виде", () => {
    expect(maxLines).toHaveLength(1);
  });

  it("версии совпадают", () => {
    const docker = /xray-core:(\d+\.\d+\.\d+)@/.exec(fromLines[0] ?? "")?.[1];
    const max = /"(\d+\.\d+\.\d+)"/.exec(maxLines[0] ?? "")?.[1];
    expect(max, `Dockerfile: ${docker}, XRAY_CORE_MAX: ${max}`).toBe(docker);
  });
});

describe("статус ядра", () => {
  it("каталог статуса создаётся в образе раньше USER", () => {
    const user = dockerfile.indexOf("USER 65532:65532");
    const mk = dockerfile.indexOf("mkdir -p /xray-status");
    const own = dockerfile.indexOf("chown 65532:65532 /xray-status");
    expect(mk).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(-1);
    expect(mk).toBeLessThan(user);
    expect(own).toBeLessThan(user);
  });

  it("том: у Xray запись, у API только чтение, объявлен", () => {
    expect(service("xray")).toMatch(/^ {6}- xray-status:\/xray-status$/m);
    expect(service("api")).toMatch(/^ {6}- xray-status:\/xray-status:ro$/m);
    expect(compose).toMatch(/^ {2}xray-status: \{\}$/m);
    expect(service("xray")).toContain("read_only: true");
  });

  it("run.sh пишет статус перед каждым запуском Xray и не использует set -e", () => {
    const lines = runSh.split("\n");
    const starts = lines.flatMap((line, i) => (line.includes('xray run -c "$CONFIG" &') ? [i] : []));
    expect(starts).toHaveLength(2);
    for (const i of starts) {
      expect(lines[i]).toMatch(/write_status; xray run -c/);
    }
    expect(runSh).not.toMatch(/^\s*set -e/m);
  });
});
