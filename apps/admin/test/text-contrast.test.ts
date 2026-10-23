import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Контраст текста панели (docs/27-design-system-and-app-shell.md §4.4, замер
// по пикселям 23.10): серый выключенного на карточке даёт 2,9–3,5:1, и им были
// набраны заголовки групп меню, подсказки полей, подсказка клавиши «/». Читать
// им нельзя — он только для выключенного, заполнителей и украшений, скрытых от
// диктора.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".tsx") ? [path] : [];
  });
}

describe("текст панели читается", () => {
  it("серый выключенного — только на украшениях, скрытых от диктора, или в вариантах placeholder: и disabled:", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const plain = line.replace(/(placeholder|disabled):text-text-disabled/g, "");
          if (plain.includes("text-text-disabled") && !plain.includes('aria-hidden="true"')) offenders.push(`${file.slice(SRC.length + 1)}:${String(index + 1)}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("плашки тона — на непрозрачной подложке, красная кнопка — с подложкой от фона", () => {
    const kit = readFileSync(join(SRC, "ui/kit.tsx"), "utf8");
    expect(kit).not.toMatch(/bg-(accent|danger|success|warning|info)\/15 text-/);
    expect(kit).toMatch(/badge-tinted \[--badge-tone:var\(--color-accent\)\]/);
    expect(kit).toMatch(/var\(--color-danger\)_8%,var\(--color-bg\)/);
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    expect(css).toMatch(/@utility badge-tinted \{[^}]*var\(--color-surface-sunken\)/);
  });

  it("фокус с клавиатуры — то же кольцо, что в игре, в слое base", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const base = /@layer base \{[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
    expect(base).toMatch(/:focus-visible \{[^}]*outline: 2px solid var\(--color-accent-glow\)/);
  });

  it("пункты меню — кольцом внутрь: колонка меню прокручивается и срезает всё снаружи", () => {
    const shell = readFileSync(join(SRC, "screens/Shell.tsx"), "utf8");
    expect(shell).toMatch(/h-\[30px\] items-center[^`]*focus-visible:-outline-offset-2/);
  });

  it("на телефоне мелкие кнопки панели — не меньше 24 px: подсказка «?» с зоной вокруг, переключатели предпросмотра — 40 px", () => {
    const kit = readFileSync(join(SRC, "ui/kit.tsx"), "utf8");
    expect(kit).toMatch(/cursor-help[^"]*after:absolute after:-inset-2\.5/);
    const preview = readFileSync(join(SRC, "ui/phone-preview.tsx"), "utf8");
    expect(preview.match(/max-md:min-h-10/g)?.length).toBe(2);
  });
});
