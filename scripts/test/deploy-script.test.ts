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
const edgeIps = read("edge-ips.sh");
const workflow = readFileSync(`${ROOT}.github/workflows/deploy.yml`, "utf8").replace(/\r\n/g, "\n");

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

  it("Postgres поднимается раньше дампа, без пересоздания", () => {
    const postgresAt = deploy.search(/API_TAG="\$VERSION" docker compose up -d --no-recreate --wait [^\n]*postgres/);
    expect(postgresAt).toBeGreaterThan(-1);
    expect(postgresAt).toBeLessThan(callAt);
  });

  it("не поднявшаяся база останавливает выкат до дампа", () => {
    const postgresAt = deploy.search(/API_TAG="\$VERSION" docker compose up -d --no-recreate --wait [^\n]*postgres/);
    const between = deploy.slice(postgresAt, callAt);
    expect(between).toContain("exit 1");
    expect(between).toContain("Postgres не поднялся");
  });

  it("образ тянется под тегом версии до дампа", () => {
    const pullAt = deploy.indexOf('API_TAG="$VERSION" docker compose pull');
    expect(pullAt).toBeGreaterThan(-1);
    expect(pullAt).toBeLessThan(callAt);
  });

  it("тег версии не уходит в окружение скрипта", () => {
    // Окружение сильнее .env: откат записал бы прежний тег в файл, а compose
    // взял бы новый из окружения и снова поднял неудавшуюся версию.
    expect(deploy).not.toMatch(/^\s*export\s+API_TAG/m);
    expect(deploy).not.toMatch(/^\s*API_TAG=\S*\s*$/m);
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

// Узлы CDN Bunny — доверенные прокси Caddy (docs/20-env-and-ports.md §2.2).
describe("edge-ips.sh: узлы CDN", () => {
  it("выкат обновляет список до перечитывания Caddy и не падает, если Bunny не ответил", () => {
    const call = deploy.indexOf("./edge-ips.sh || log");
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(deploy.indexOf("caddy reload"));
    expect(deploy).toContain("EDGE_IPS_NO_RELOAD=1");
  });

  it("сверка раз в сутки стоит в crontab рядом с бэкапом", () => {
    expect(deploy).toMatch(/edge_line="[^"]*edge-ips\.sh/);
    expect(deploy).toContain("-e \"${APP}/edge-ips.sh\"");
    expect(deploy).toContain("echo \"$edge_line\"");
  });

  it("workflow выката кладёт скрипт на сервер и делает исполняемым", () => {
    expect(workflow).toContain("infra/prod/edge-ips.sh");
    expect(workflow).toMatch(/chmod 755 [^&]*edge-ips\.sh/);
  });

  it("обрезанный ответ Bunny не заменяет прежний список", () => {
    expect(edgeIps).toMatch(/MIN_ADDRESSES=\d+/);
    expect(edgeIps.indexOf("exit 1")).toBeLessThan(edgeIps.indexOf("install -m 644"));
  });
});

describe.each([
  ["deploy.sh", deploy],
  ["backup.sh", backup],
  ["edge-ips.sh", edgeIps],
])("%s", (name, text) => {
  it("начинается с bash-шебанга и включает строгий режим", () => {
    expect(text.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(text).toContain("set -euo pipefail");
  });

  it.skipIf(process.platform === "win32")("проходит bash -n", () => {
    expect(() => execFileSync("bash", ["-n", `${ROOT}infra/prod/${name}`])).not.toThrow();
  });
});
