import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Прокси dev-сервера Telegram (apps/web-telegram/vite.config.ts). В dev клиент
// ходит в API на свой же домен, и префикс, которого нет в прокси, Vite
// отвечает сам — 404. Так вход и забеги под аккаунтом не работали на
// dev-сервере, а форма обратной связи молча не отправлялась: заметить это
// можно только руками в браузере. Поэтому сверка — по исходникам.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Префиксы вида `/api/v1/<модуль>`, к которым обращается код. */
function prefixesIn(text: string): Set<string> {
  return new Set([...text.matchAll(/\/api\/v1\/([a-z][a-z-]*)/g)].map((match) => match[1] ?? ""));
}

const clientPrefixes = new Set(
  sources(join(repoRoot, "packages/app-shell/src")).flatMap((path) => [...prefixesIn(readFileSync(path, "utf8"))]),
);

const viteConfig = readFileSync(join(repoRoot, "apps/web-telegram/vite.config.ts"), "utf8");
const proxyList = /\[(\s*"\/api\/v1\/[a-z-]+",?)+\s*\]/.exec(viteConfig)?.[0] ?? "";
const proxied = prefixesIn(proxyList);

describe("прокси dev-сервера", () => {
  it("список прокси найден: иначе сверять не с чем", () => {
    expect(proxied.size).toBeGreaterThan(0);
  });

  it("пересылает каждый префикс API, к которому ходит клиент", () => {
    expect([...clientPrefixes].filter((prefix) => !proxied.has(prefix)).sort()).toEqual([]);
  });

  it("не выпускает наружу то, что сам себя не защищает", () => {
    // Туннель dev-сервера видит любой, у кого ссылка. Роли и журнал аудита
    // защищены только правами, а проверять их через туннель незачем
    // (docs/20-env-and-ports.md §4).
    expect(proxied.has("roles")).toBe(false);
  });
});
