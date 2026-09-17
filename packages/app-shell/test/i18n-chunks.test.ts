import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasTranslation } from "../src/i18n";

// Словарь гайдбука приезжает отдельным чанком (`i18n/guide.ts`), и это даёт
// осечку, которую не видно ни типами, ни сборкой: ключ, оставшийся в чанке,
// но нужный экрану без него, показывается игроку как есть — `guide.lobby.title`
// вместо текста. Ровно так и случилось на главной.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Ключи, которые экран просит у словаря напрямую строкой. */
function keysUsedIn(file: string): string[] {
  const source = readFileSync(`${SRC}/${file}`, "utf8");
  return [...source.matchAll(/t\("([a-z][\w.]*)"/gi)].map((match) => match[1]);
}

describe("словари по чанкам", () => {
  it("экраны вне гайдбука не просят ключей, уехавших в его чанк", () => {
    // Основной словарь уже загружен импортом `../src/i18n`; чанк гайдбука —
    // нет, и в этом весь смысл проверки.
    for (const file of ["screens/home.tsx", "app/MainMenu.tsx"]) {
      for (const key of keysUsedIn(file)) {
        expect(hasTranslation(key), `${file}: ${key}`).toBe(true);
      }
    }
  });
});
