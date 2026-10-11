import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Скрипты выката и бэкапа читаются текстом: живьём их гонят на сервере.
// Порядок строк и шаблоны ротации — то, что ломается незаметно
// (docs/09-ci-cd.md §10, docs/20-env-and-ports.md §5.4).

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (name: string): string => readFileSync(`${ROOT}infra/prod/${name}`, "utf8").replace(/\r\n/g, "\n");
const deploy = read("deploy.sh");
const backup = read("backup.sh");

describe("deploy.sh: бэкап перед выкатом", () => {
  const callAt = deploy.search(/backup\.sh"? --before-deploy "\$VERSION"/);

  it("зовёт backup.sh --before-deploy", () => {
    expect(callAt).toBeGreaterThan(-1);
  });

  it("дамп делается раньше смены тега API и подъёма контейнера", () => {
    const tagAt = deploy.indexOf('set_env_value API_TAG "$VERSION"');
    const upAt = deploy.indexOf("docker compose up -d --wait");
    expect(tagAt).toBeGreaterThan(-1);
    expect(upAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(tagAt);
    expect(callAt).toBeLessThan(upAt);
  });

  it("после дампа места проверяется ещё раз", () => {
    expect(deploy.slice(callAt)).toContain("ensure_space");
    expect(deploy.slice(callAt).indexOf("ensure_space")).toBeLessThan(deploy.slice(callAt).indexOf('set_env_value API_TAG "$VERSION"'));
  });

  it("не сделанный дамп останавливает выкат", () => {
    expect(deploy).toMatch(/elif ! "\$\{APP\}\/backup\.sh" --before-deploy "\$VERSION"; then[\s\S]*?exit 1/);
  });

  it("--no-backup пропускает дамп с предупреждением в логе", () => {
    expect(deploy).toContain("--no-backup");
    expect(deploy).toContain("без бэкапа");
  });

  it("второй аргумент, кроме --no-backup, — ошибка", () => {
    expect(deploy).toMatch(/\$\{2:-\}/);
  });
});

describe("backup.sh: режим перед выкатом", () => {
  it("знает --before-deploy и пишет в rubezh-pre-", () => {
    expect(backup).toContain("--before-deploy");
    expect(backup).toContain("rubezh-pre-");
  });

  it("неизвестный аргумент — выход 2", () => {
    expect(backup).toMatch(/exit 2/);
  });

  it("версия в имени файла ограничена безопасными символами", () => {
    expect(backup).toContain("[0-9A-Za-z.+-]");
  });

  it("ротация ночных не захватывает дампы перед выкатом", () => {
    expect(backup).not.toContain("rubezh-*.dump.age");
    expect(backup).toContain("rubezh-2*.dump.age");
  });

  it("дампы перед выкатом ротируются отдельно: последние 3", () => {
    expect(backup).toMatch(/KEEP_PRE_DEPLOY=3/);
    expect(backup).toContain("rubezh-pre-*.dump.age");
  });

  it("печатает строку «бэкап перед выкатом»", () => {
    expect(backup).toContain("бэкап перед выкатом:");
  });
});

describe.each([
  ["deploy.sh", deploy],
  ["backup.sh", backup],
])("%s", (name, text) => {
  it("начинается с bash-шебанга и включает строгий режим", () => {
    expect(text.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(text).toContain("set -euo pipefail");
  });

  it.skipIf(process.platform === "win32")("проходит bash -n", () => {
    expect(() => execFileSync("bash", ["-n", `${ROOT}infra/prod/${name}`])).not.toThrow();
  });
});
