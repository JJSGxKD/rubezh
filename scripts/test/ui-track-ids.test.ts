import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Храповик разметки нажатий (tasks/T-0226, docs/35-stage4-plan.md Р141): в
 * `.tsx` оболочки считаются `<Button`, `<IconButton`, `<TabBar` и
 * `<SegmentedControl` без `track=`. Число в файле не должно расти: новая кнопка
 * приходит уже с именем. Уменьшилось — база уменьшается следом, чтобы
 * выигранное не потерялось. База — `ui-track-baseline.json`; пересобрать её
 * после разметки экранов: `UPDATE_UI_TRACK_BASELINE=1 pnpm vitest run scripts/test/ui-track-ids.test.ts`.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_DIR = join(ROOT, "packages/app-shell/src");
const BASELINE_FILE = fileURLToPath(new URL("./ui-track-baseline.json", import.meta.url));

const TAG_RE = /<(Button|IconButton|TabBar|SegmentedControl)(?=[\s/>])/g;

/** Конец открывающего тега: первый `>` вне скобок `{}` и кавычек. */
function tagEnd(source: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return index;
  }
  return source.length;
}

/** Сколько кнопок, вкладок и переключателей в тексте файла без `track=`. */
export function countUntracked(source: string): number {
  let count = 0;
  for (const match of source.matchAll(TAG_RE)) {
    const start = (match.index ?? 0) + match[0].length;
    const tag = source.slice(start, tagEnd(source, start));
    if (!/(^|\s)track=/.test(tag)) count += 1;
  }
  return count;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : name.endsWith(".tsx") ? [path] : [];
  });
}

/** `{ "<путь от корня>": число }` по всем `.tsx` каталога; файлы без кнопок без track не попадают. */
export function scan(dir: string, root: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of walk(dir).sort()) {
    const count = countUntracked(readFileSync(path, "utf8"));
    if (count > 0) counts[relative(root, path).split(sep).join("/")] = count;
  }
  return counts;
}

/** Расхождения с базой: рост или новый файл — ошибка; уменьшение — просьба уменьшить базу. */
export function compare(actual: Record<string, number>, baseline: Record<string, number>): string[] {
  const problems: string[] = [];
  for (const [file, count] of Object.entries(actual)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) problems.push(`${file}: новая кнопка без track — дай ей имя (было ${String(allowed)}, стало ${String(count)})`);
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = actual[file] ?? 0;
    if (count < allowed) problems.push(`${file}: кнопок без track стало меньше (${String(count)} вместо ${String(allowed)}) — уменьши число в ui-track-baseline.json`);
  }
  return problems;
}

describe("счёт кнопок без track", () => {
  it("считает все четыре компонента, многострочные теги и вложенные скобки", () => {
    const source = [
      "<Button onClick={() => go(1)}>a</Button>",
      '<Button track="buy" onClick={() => go(2)}>b</Button>',
      "<IconButton",
      '  label="x"',
      "  onClick={() => (a > b ? 1 : 2)}",
      ">",
      "  z",
      "</IconButton>",
      '<TabBar items={[]} track="tabs" />',
      "<SegmentedControl items={x} />",
      "<ButtonGroup>не кнопка</ButtonGroup>",
    ].join("\n");
    expect(countUntracked(source)).toBe(3);
  });
});

describe("храповик по базе", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "ui-track-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  }

  it("кнопка без track в файле с базой 0 — падение с именем файла", () => {
    const dir = project({ "a/Shop.tsx": "<Button>Купить</Button>" });
    const problems = compare(scan(dir, dir), {});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("a/Shop.tsx");
    expect(problems[0]).toContain("новая кнопка без track");
  });

  it("число меньше базы — просьба уменьшить базу", () => {
    const dir = project({ "a/Shop.tsx": '<Button track="buy">Купить</Button>' });
    const problems = compare(scan(dir, dir), { "a/Shop.tsx": 2 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("уменьши");
  });

  it("совпадает с базой — зелёный", () => {
    const dir = project({ "a/Shop.tsx": "<Button>a</Button><IconButton label=\"x\" />" });
    expect(compare(scan(dir, dir), { "a/Shop.tsx": 2 })).toEqual([]);
  });
});

describe("оболочка", () => {
  it("кнопок без track не больше, чем в базе", () => {
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Record<string, number>;
    const actual = scan(SOURCE_DIR, ROOT);
    if (process.env.UPDATE_UI_TRACK_BASELINE === "1") {
      writeFileSync(BASELINE_FILE, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    expect(compare(actual, baseline)).toEqual([]);
  });
});
