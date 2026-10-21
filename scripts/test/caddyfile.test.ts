import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Префикс панели (/api/v1/admin/*) живёт только на домене панели: у неё своя
// cookie-сессия, и другие домены не должны открывать к ней дверь.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ADMIN_PREFIX = "handle /api/v1/admin/* {";
const ADMIN_DOMAIN = "admin.{$DOMAIN}";
/** До API ходят только через сниппет: адрес игрока и кэш за CDN — в одном месте. */
const PROXY_API = "import api";

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
      block.indexOf(PROXY_API),
    );
  });

  it("на домене клиента префикс панели закрыт раньше прокси", () => {
    const block = blockOf("tg.{$DOMAIN}");
    expect(handleBody(block, ADMIN_PREFIX)).toContain("respond 404");
    expect(block.indexOf(ADMIN_PREFIX)).toBeLessThan(
      block.indexOf(PROXY_API),
    );
  });

  it("панель проксирует свой префикс", () => {
    expect(handleBody(blockOf(ADMIN_DOMAIN), ADMIN_PREFIX)).toContain(
      PROXY_API,
    );
  });

  it("новый домен с API не забудет закрыть префикс", () => {
    const exposing = [...blocks].filter(
      ([name, block]) =>
        name !== ADMIN_DOMAIN &&
        (block.includes("\thandle /api/* {") ||
          /^\timport api$/m.test(block) ||
          block.includes(`\thandle {\n\t\t${PROXY_API}`)),
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

/** Тело сниппета `(имя) { … }` на нулевом отступе. */
function snippetBody(name: string): string {
  const start = caddyfile.indexOf(`\n(${name}) {\n`);
  if (start === -1) throw new Error(`В Caddyfile нет сниппета (${name})`);
  const from = start + name.length + 6;
  return caddyfile.slice(from, caddyfile.indexOf("\n}\n", from));
}

// Клиент и лендинг — за CDN Bunny (docs/20-env-and-ports.md §2.2): к Caddy
// приходит узел CDN, адрес игрока — в X-Forwarded-For.
describe("Caddyfile: за CDN", () => {
  it("адрес игрока берётся из заголовка только у доверенных узлов, справа налево", () => {
    const global = caddyfile.slice(caddyfile.indexOf("\n{\n"), caddyfile.indexOf("\n}\n"));
    expect(global).toContain("import edge/trusted-proxies*.caddy");
    expect(global).toContain("trusted_proxies_strict");
    expect(global).toContain("client_ip_headers X-Forwarded-For");
  });

  it("до API — один адрес игрока и no-store по умолчанию", () => {
    const api = snippetBody("api");
    expect(api).toContain("header_up X-Forwarded-For {client_ip}");
    expect(api).toContain('header ?Cache-Control "no-store"');
  });

  it("мимо сниппета до API никто не ходит", () => {
    const outside = caddyfile.replace(snippetBody("api"), "");
    expect(outside).not.toMatch(/reverse_proxy api:4000/);
  });

  it("навсегда кэшируются только файлы с хэшем, остальное — no-cache", () => {
    const spa = snippetBody("spa");
    expect(spa).toMatch(/handle @hashed \{\n\t\theader Cache-Control "public, max-age=31536000, immutable"\n\t\tfile_server\n\t\}/);
    expect(spa).toMatch(/\thandle \{\n\t\theader Cache-Control "no-cache"\n\t\ttry_files \{path\} \/index\.html/);
  });
});

// Панель тоже за CDN Bunny (Р134): адрес администратора и кэш приходят из общих
// частей, блок домена ничего не переопределяет.
describe("Caddyfile: панель за CDN", () => {
  const admin = (): string => blockOf(ADMIN_DOMAIN);

  it("блок панели собран из общих частей", () => {
    for (const part of ["import edge", "import edge/admin*.caddy", "import spa admin", "header X-Frame-Options DENY"]) expect(admin(), part).toContain(part);
  });

  it("блок панели ничего не переопределяет: адрес и кэш — из сниппетов и глобального блока", () => {
    for (const own of ["trusted_proxies", "client_ip_headers", "header_up", "reverse_proxy", "Cache-Control"]) expect(admin(), own).not.toContain(own);
  });

  it("префикс панели — ровно через сниппет api, остальной /api/* — 404", () => {
    expect(handleBody(admin(), ADMIN_PREFIX)?.trim()).toBe(PROXY_API);
    expect(handleBody(admin(), "handle /api/* {")?.trim()).toBe("respond 404");
  });

  it("доверие узлам CDN задано один раз, глобально", () => {
    for (const [name, body] of blocks) {
      expect(body, name).not.toContain("trusted_proxies");
      expect(body, name).not.toContain("client_ip_headers");
    }
  });

  it("домены за CDN идут через import edge; api и туннели к CDN-специфике не привязаны", () => {
    for (const name of ["{$DOMAIN}", "tg.{$DOMAIN}", ADMIN_DOMAIN]) expect(blockOf(name), name).toContain("import edge");
    expect(blockOf("api.{$DOMAIN}")).not.toContain("import edge/");
    for (const [name, body] of blocks) {
      if (name.includes(".dev.")) expect(body, name).not.toContain("import edge");
    }
  });

  it("верхний комментарий называет панель среди доменов за CDN", () => {
    const comment = caddyfile.slice(0, caddyfile.indexOf("\n{\n"));
    expect(comment).toMatch(/Клиент, лендинг и панель — за CDN Bunny/);
  });
});
