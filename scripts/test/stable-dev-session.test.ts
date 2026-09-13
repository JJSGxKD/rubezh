import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isViteClient, patchViteClient } from "../vite/stable-dev-session";

/**
 * Плагин меняет код клиента Vite по шаблону. Тест читает клиент из
 * установленной версии: обновление Vite, поменявшее это место, падает здесь, а
 * не возвращает тестерам перезагрузки молча.
 */
const require = createRequire(import.meta.url);
const clientPath = join(dirname(require.resolve("vite/package.json")), "dist/client/client.mjs");
const client = readFileSync(clientPath, "utf8");

describe("dev-сервер без перезагрузок на обрыве связи", () => {
  it("находит перезагрузку после переподключения в установленном клиенте Vite", () => {
    const patched = patchViteClient(client);

    expect(patched, "шаблон не найден — клиент Vite поменялся").not.toBeNull();
    expect(patched).not.toMatch(/await waitForSuccessfulPing\(url\.href\);\s*location\.reload\(\);/);
    expect(patched).toContain("rubezh-dev-stale-session");
  });

  it("не трогает перезагрузку по команде сервера — её просит разработчик правкой кода", () => {
    const patched = patchViteClient(client) ?? "";
    const countReloads = (code: string): number => code.split("location.reload()").length - 1;

    // Ушла ровно одна перезагрузка; плашка добавляет свою — по нажатию.
    expect(countReloads(patched)).toBe(countReloads(client));
  });

  it("узнаёт клиент по пути с любыми разделителями", () => {
    expect(isViteClient("F:\\repo\\node_modules\\vite\\dist\\client\\client.mjs")).toBe(true);
    expect(isViteClient("/repo/node_modules/vite/dist/client/client.mjs")).toBe(true);
    expect(isViteClient("/repo/src/client.mjs")).toBe(false);
  });
});
