import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OUTBOUND_SERVICES } from "../src/infra/outbound/outbound-services.js";

/**
 * Все вызовы внешних API идут через `Outbound.forService` (tasks/T-0059):
 * иначе журнал запросов и прокси будут видеть не всё. Проверка по исходникам;
 * сообщение называет файл и строку.
 */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Единственное место, где разрешён глобальный `fetch`. */
const CLIENT_DIR = "infra/outbound/";

/**
 * Параметры, у которых умолчание — глобальный `fetch`: нужны тестам модулей,
 * которые подменяют сеть. Новый код в модулях берёт клиент из DI.
 */
const KNOWN_DEFAULTS = new Set<string>([
  "modules/admin/admin-secrets.service.ts: ?? fetch",
  "modules/ad-conversions/conversions.service.ts: ?? fetch",
  "modules/ads/taddy-api.ts: private readonly fetchImpl: typeof fetch = fetch,",
  "modules/ads/taddy-exchange.ts: private readonly fetchImpl: typeof fetch = fetch,",
  "modules/fx/fx.refresher.ts: () => fetch",
  "platforms/telegram/telegram-bot-api.ts: fetchImpl: FetchLike = fetch,",
]);

/**
 * Метки каталога, под которые отдельного места вызова пока нет: креатив Taddy
 * приходит тем же клиентом, что и остальные вызовы `taddy.api`. Метка
 * зарезервирована за сетями со своим API креативов.
 */
const RESERVED = new Set<string>(["ads.creatives"]);

function sourcesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name));
}

function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
}

/** Значение `fetch`, взятое из окружения: вызов, умолчание, передача. Тип, имя метода и ключ объекта не считаются. */
const GLOBAL_FETCH = /(?<![.\w$])fetch(?![\w$])(?!\s*:)(?!\?)/;

function offenders(): { site: string; line: string; where: string }[] {
  const found: { site: string; line: string; where: string }[] = [];
  for (const file of sourcesOf(SRC)) {
    const path = relative(SRC, file).split(sep).join("/");
    if (path.startsWith(CLIENT_DIR)) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (isComment(line)) return;
        const code = line.replace(/typeof\s+fetch/g, "").replace(/^\s*(async\s+)?fetch\(.*$/, "").replace(/\bfetch\s*:/g, "");
        if (GLOBAL_FETCH.test(code)) found.push({ site: path, line: line.trim(), where: `${path}:${index + 1}` });
      });
  }
  return found;
}

describe("исходящие запросы идут через один клиент", () => {
  it("глобальный fetch нигде, кроме клиента, не вызывается и не подставляется без причины", () => {
    const unknown = offenders().filter(({ site, line }) => ![...KNOWN_DEFAULTS].some((known) => known.startsWith(`${site}: `) && line.includes(known.slice(site.length + 2))));
    expect(unknown.map((item) => item.where), `новое место вызова мимо Outbound: ${unknown.map((item) => `${item.where} — ${item.line}`).join("; ")}`).toEqual([]);
  });

  it("известные умолчания не устарели: каждое ещё есть в исходниках", () => {
    const present = offenders();
    for (const known of KNOWN_DEFAULTS) {
      const site = known.slice(0, known.indexOf(": "));
      const text = known.slice(site.length + 2);
      expect(present.some((item) => item.site === site && item.line.includes(text)), known).toBe(true);
    }
  });

  it("каждый forService в исходниках — сервис из каталога, и каждый сервис каталога где-то используется", () => {
    const used = new Set<string>();
    for (const file of sourcesOf(SRC)) {
      const path = relative(SRC, file).split(sep).join("/");
      if (path.startsWith(CLIENT_DIR)) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/forService\(\s*["']([^"']+)["']/g)) used.add(match[1] ?? "");
      for (const match of text.matchAll(/["']((?:fx|telegram|taddy|ads|secrets)\.[a-z]+)["']/g)) {
        if ((OUTBOUND_SERVICES as readonly string[]).includes(match[1] ?? "")) used.add(match[1] ?? "");
      }
    }
    for (const service of used) expect(OUTBOUND_SERVICES as readonly string[], service).toContain(service);
    for (const service of OUTBOUND_SERVICES) expect(used.has(service) || RESERVED.has(service), `сервис ${service} никто не использует`).toBe(true);
  });
});
