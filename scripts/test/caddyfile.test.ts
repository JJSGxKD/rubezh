import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Префикс панели (/api/v1/admin/*) живёт только на домене панели: у неё своя
// cookie-сессия, и другие домены не должны открывать к ней дверь.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ADMIN_PREFIX = "handle /api/v1/admin/* {";
const ADMIN_DOMAIN = "admin.{$DOMAIN}";

const caddyfile = readFileSync(`${ROOT}infra/prod/Caddyfile`, "utf8").replace(
  /\r\n/g,
  "\n",
);

/** Блоки доменов: строка без отступа, кончающаяся на `{`, до `}` на нулевом отступе. */
function parseDomainBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^([^\s#(][^\s]*(?: [^\s{]+)*)\s*\{$/.exec(lines[i] ?? "");
    if (!head || !head[1] || head[1] === "import") continue;
    const body: string[] = [];
    i += 1;
    while (i < lines.length && lines[i] !== "}") {
      body.push(lines[i] ?? "");
      i += 1;
    }
    blocks.set(head[1], body.join("\n"));
  }
  return blocks;
}

/** Тело `handle <matcher> { … }` на отступе в одну табуляцию. */
function handleBody(block: string, header: string): string | undefined {
  const lines = block.split("\n");
  const start = lines.indexOf(`\t${header}`);
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && lines[i] !== "\t}"; i += 1)
    body.push(lines[i] ?? "");
  return body.join("\n");
}

const blocks = parseDomainBlocks(caddyfile);

function blockOf(name: string): string {
  const block = blocks.get(name);
  if (block === undefined) throw new Error(`В Caddyfile нет блока ${name}`);
  return block;
}

describe("Caddyfile: префикс панели", () => {
  it("на домене API префикс панели закрыт раньше прокси", () => {
    const block = blockOf("api.{$DOMAIN}");
    expect(handleBody(block, ADMIN_PREFIX)).toContain("respond 404");
    expect(block.indexOf(ADMIN_PREFIX)).toBeGreaterThanOrEqual(0);
    expect(block.indexOf(ADMIN_PREFIX)).toBeLessThan(
      block.indexOf("reverse_proxy"),
    );
  });

  it("на домене клиента префикс панели закрыт раньше прокси", () => {
    const block = blockOf("tg.{$DOMAIN}");
    expect(handleBody(block, ADMIN_PREFIX)).toContain("respond 404");
    expect(block.indexOf(ADMIN_PREFIX)).toBeLessThan(
      block.indexOf("reverse_proxy"),
    );
  });

  it("панель проксирует свой префикс", () => {
    expect(handleBody(blockOf(ADMIN_DOMAIN), ADMIN_PREFIX)).toContain(
      "reverse_proxy api:4000",
    );
  });

  it("новый домен с API не забудет закрыть префикс", () => {
    const exposing = [...blocks].filter(
      ([name, block]) =>
        name !== ADMIN_DOMAIN &&
        (block.includes("\thandle /api/* {") ||
          /^\treverse_proxy api:4000$/m.test(block) ||
          block.includes("\thandle {\n\t\treverse_proxy api:4000")),
    );
    expect(exposing.map(([name]) => name)).toEqual(
      expect.arrayContaining(["tg.{$DOMAIN}", "api.{$DOMAIN}"]),
    );
    for (const [name, block] of exposing) {
      expect(block, `в блоке ${name} не закрыт ${ADMIN_PREFIX}`).toContain(
        `\t${ADMIN_PREFIX}`,
      );
    }
  });
});
