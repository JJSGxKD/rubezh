import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { canonicalName, checkImagePins, classifyImage, findFromImages, findVersionDrift, findYamlImages } from "../image-pins.mjs";

// Docker-образы — точным тегом и digest (docs/09-ci-cd.md §12): тег
// перевешивают на каждый патч, digest — нет.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIGEST = `sha256:${"b0f9560a2de083e2".repeat(4)}`;
const OTHER = `sha256:${"858f009f9709ce57".repeat(4)}`;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "image-pins-"));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

describe("образы в репозитории", () => {
  it("все закреплены точной версией и digest, у каждого одна версия", () => {
    expect(checkImagePins(ROOT).errors).toEqual([]);
  });

  it("проверка действительно их видит, а не проходит по пустому списку", () => {
    const places = checkImagePins(ROOT).pins.map((pin: { name: string; where: string }) => `${pin.name} ${pin.where.split(":")[0]}`);

    expect(places).toEqual(
      expect.arrayContaining([
        "postgres .github/workflows/ci.yml",
        "redis .github/workflows/ci.yml",
        "postgres docker-compose.yml",
        "redis docker-compose.yml",
        "node backend/api/Dockerfile",
      ]),
    );
  });
});

describe("classifyImage", () => {
  it("принимает точную версию с digest", () => {
    expect(classifyImage(`postgres:17.11-alpine3.24@${DIGEST}`)).toEqual({
      kind: "pinned",
      name: "postgres",
      tag: "17.11-alpine3.24",
      digest: DIGEST,
      ref: `postgres:17.11-alpine3.24@${DIGEST}`,
    });
  });

  it("принимает версию с v, Debian по кодовому имени и образ из другого реестра", () => {
    expect(classifyImage(`ghcr.io/org/rubezh-api:v0.5.0@${DIGEST}`)).toMatchObject({ kind: "pinned", name: "ghcr.io/org/rubezh-api" });
    expect(classifyImage(`node:22.22.3-bookworm-slim@${DIGEST}`)).toMatchObject({ kind: "pinned", tag: "22.22.3-bookworm-slim" });
    expect(classifyImage(`registry.local:5000/tools/pg:17.11@${DIGEST}`)).toMatchObject({
      kind: "pinned",
      name: "registry.local:5000/tools/pg",
      tag: "17.11",
    });
  });

  it("отклоняет тег без digest, даже точный: точный тег тоже пересобирают", () => {
    for (const ref of ["postgres:17-alpine", "postgres:17.11-alpine3.24", "redis", "redis:latest"]) {
      expect(classifyImage(ref).kind).toBe("problem");
    }
  });

  it("отклоняет плавающий тег и при digest: по нему не видно, что закреплено", () => {
    for (const tag of ["17-alpine", "17", "latest", "alpine", "lts-slim"]) {
      expect(classifyImage(`postgres:${tag}@${DIGEST}`).kind).toBe("problem");
    }
  });

  it("требует версию Alpine в теге alpine-варианта", () => {
    expect(classifyImage(`redis:7.4.11-alpine@${DIGEST}`).kind).toBe("problem");
    expect(classifyImage(`redis:7.4.11-alpine3@${DIGEST}`).kind).toBe("problem");
    expect(classifyImage(`redis:7.4.11-alpine3.21@${DIGEST}`).kind).toBe("pinned");
  });

  it("отклоняет digest без тега: версию на ревью не прочитать", () => {
    expect(classifyImage(`postgres@${DIGEST}`).kind).toBe("problem");
    expect(classifyImage(`registry.local:5000/pg@${DIGEST}`).kind).toBe("problem");
  });

  it("отклоняет короткий digest, digest заглавными и другой алгоритм", () => {
    expect(classifyImage("postgres:17.11-alpine3.24@sha256:b0f9560a2de0").kind).toBe("problem");
    expect(classifyImage(`postgres:17.11-alpine3.24@${DIGEST.toUpperCase()}`).kind).toBe("problem");
    expect(classifyImage(`postgres:17.11-alpine3.24@sha512:${"a".repeat(128)}`).kind).toBe("problem");
  });

  it("отклоняет образ из переменной: по файлу не видно, что запустится", () => {
    expect(classifyImage(`postgres:\${PG_VERSION}@${DIGEST}`).kind).toBe("problem");
    expect(classifyImage("${{ matrix.image }}").kind).toBe("problem");
  });

  it("сообщение называет ссылку и показывает, как исправить", () => {
    const result = classifyImage("postgres:17-alpine");

    expect(result.message).toContain("postgres:17-alpine");
    expect(result.message).toContain("postgres:<версия>@sha256:<digest>");
  });
});

describe("canonicalName", () => {
  it("сводит полную запись Docker Hub к короткой", () => {
    expect(canonicalName("docker.io/library/postgres")).toBe("postgres");
    expect(canonicalName("index.docker.io/library/postgres")).toBe("postgres");
    expect(canonicalName("library/postgres")).toBe("postgres");
    expect(canonicalName("docker.io/bitnami/redis")).toBe("bitnami/redis");
    expect(canonicalName("ghcr.io/org/api")).toBe("ghcr.io/org/api");
  });
});

describe("findYamlImages", () => {
  it("находит image: сервисов, в кавычках и без, и в элементе списка", () => {
    const text = [
      "services:",
      "  postgres:",
      `    image: postgres:17.11-alpine3.24@${DIGEST} # как в CI`,
      "  redis:",
      `    image: "redis:7.4.11-alpine3.21@${OTHER}"`,
      `  - image: 'node:22'`,
    ].join("\n");

    expect(findYamlImages(text, false)).toEqual({
      found: [
        { line: 3, ref: `postgres:17.11-alpine3.24@${DIGEST}` },
        { line: 5, ref: `redis:7.4.11-alpine3.21@${OTHER}` },
        { line: 6, ref: "node:22" },
      ],
      unparsed: [],
    });
  });

  it("в workflow читает короткую форму container:, а блок container: пропускает", () => {
    const text = ["jobs:", "  a:", "    container: node:22", "  b:", "    container:", `      image: node:22.22.3@${DIGEST}`].join("\n");

    expect(findYamlImages(text, true).found).toEqual([
      { line: 3, ref: "node:22" },
      { line: 6, ref: `node:22.22.3@${DIGEST}` },
    ]);
  });

  it("вне workflow container: не образ", () => {
    expect(findYamlImages("    container: rubezh", false)).toEqual({ found: [], unparsed: [] });
  });

  it("не путает с образом закомментированную строку, переменную IMAGE и шаг с id: image", () => {
    const text = ["    # image: postgres:17-alpine", "          IMAGE: ${{ steps.image.outputs.name }}", "        id: image"].join("\n");

    expect(findYamlImages(text, true)).toEqual({ found: [], unparsed: [] });
  });

  it("строку, которую не разобрала, отдаёт отдельно, а не пропускает молча", () => {
    const text = ["  - { image: postgres:17 }", '    "image": postgres:17', "    image:", "    image: postgres:17 extra"].join("\n");

    expect(findYamlImages(text, false)).toEqual({ found: [], unparsed: [1, 2, 3, 4] });
  });

  it("не спотыкается о перевод строки CRLF", () => {
    expect(findYamlImages(`    image: redis:7.4.11-alpine3.21@${OTHER}\r\n`, false).found).toEqual([
      { line: 1, ref: `redis:7.4.11-alpine3.21@${OTHER}` },
    ]);
  });
});

describe("findFromImages", () => {
  it("пропускает этапы многоэтапной сборки и scratch, ключи перед образом — тоже", () => {
    const text = [
      "# FROM node:latest",
      `FROM --platform=$BUILDPLATFORM node:22.22.3-bookworm-slim@${DIGEST} AS base`,
      "FROM base AS deps",
      "from Deps as build",
      "FROM scratch AS empty",
      "FROM alpine:3.21",
    ].join("\n");

    expect(findFromImages(text)).toEqual({
      found: [
        { line: 2, ref: `node:22.22.3-bookworm-slim@${DIGEST}` },
        { line: 6, ref: "alpine:3.21" },
      ],
      unparsed: [],
    });
  });

  it("имя этапа, объявленного ниже, — ещё образ из реестра", () => {
    expect(findFromImages("FROM base\nFROM node:22 AS base").found).toEqual([
      { line: 1, ref: "base" },
      { line: 2, ref: "node:22" },
    ]);
  });

  it("строку FROM, которую не разобрала, отдаёт отдельно", () => {
    expect(findFromImages(["FROM", "FROM --platform=linux/amd64", "FROM node:22 AS", "FROM node:22 base"].join("\n"))).toEqual({
      found: [],
      unparsed: [1, 2, 3, 4],
    });
  });
});

describe("findVersionDrift", () => {
  function pin(where: string, name: string, tag: string, digest = DIGEST) {
    return { kind: "pinned", name, tag, digest, ref: `${name}:${tag}@${digest}`, where };
  }

  it("одна версия в нескольких местах — не ошибка", () => {
    expect(findVersionDrift([pin("ci.yml:34", "postgres", "17.11"), pin("docker-compose.yml:14", "postgres", "17.11")])).toEqual([]);
  });

  it("разные версии одного образа — ошибка со всеми местами", () => {
    const [error, ...rest] = findVersionDrift([
      pin("ci.yml:34", "postgres", "17.11-alpine3.24"),
      pin("docker-compose.yml:14", "postgres", "17.10-alpine3.24"),
      pin("ci.yml:45", "redis", "7.4.11-alpine3.21", OTHER),
    ]);

    expect(rest).toEqual([]);
    expect(error).toContain("postgres — разные версии");
    expect(error).toContain("ci.yml:34 17.11-alpine3.24@sha256:b0f9560a2de0");
    expect(error).toContain("docker-compose.yml:14 17.10-alpine3.24");
  });

  it("та же версия с другим digest — тоже расхождение: пересборка под тем же тегом", () => {
    expect(findVersionDrift([pin("ci.yml:34", "postgres", "17.11"), pin("docker-compose.yml:14", "postgres", "17.11", OTHER)])).toHaveLength(1);
  });
});

describe("checkImagePins", () => {
  it("обходит workflow, compose и Dockerfile, называет файл и строку и ловит расхождение между ними", () => {
    const root = fixture({
      ".github/workflows/ci.yml": `services:\n  postgres:\n    image: postgres:17.11-alpine3.24@${DIGEST}\n  redis:\n    image: redis:7-alpine\n`,
      ".github/release.yml": "image: не-образ\n",
      "docker-compose.yml": `services:\n  postgres:\n    image: docker.io/library/postgres:17.10-alpine3.24@${OTHER}\n`,
      "infra/prod/compose.prod.yaml": "services:\n  api:\n    image: ghcr.io/org/api:latest\n",
      "backend/api/Dockerfile": `FROM node:22.22.3-bookworm-slim@${DIGEST} AS base\nFROM base AS build\n`,
      "apps/web/worker.Dockerfile": "FROM node:22-alpine\n",
      "apps/web/node_modules/pkg/Dockerfile": "FROM node:latest\n",
      ".claude/worktrees/copy/docker-compose.yml": "services:\n  db:\n    image: postgres\n",
    });

    const report = checkImagePins(root);

    expect(report.files).toBe(5);
    expect(report.pins.map((pin: { where: string }) => pin.where)).toEqual([
      ".github/workflows/ci.yml:3",
      "backend/api/Dockerfile:1",
      "docker-compose.yml:3",
    ]);
    expect(report.errors.map((error: string) => error.split(" ")[0])).toEqual([
      ".github/workflows/ci.yml:5",
      "apps/web/worker.Dockerfile:1",
      "infra/prod/compose.prod.yaml:3",
      "postgres",
    ]);
  });
});
