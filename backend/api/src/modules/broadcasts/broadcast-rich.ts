import { createHash } from "node:crypto";
import { richProblems, type RichBlock, type RichDocument, type RichText } from "../../platforms/ports/rich-message.js";

/**
 * Оформленная рассылка: ограниченный Markdown из панели → `RichDocument`
 * (docs/29-admin-panel.md §7.2, docs/35-stage4-plan.md Р199, tasks/T-0403).
 * Текст из панели недоверенный, поэтому разбор свой и узкий: понимает ровно
 * перечисленное, всё остальное — ошибка с номером строки, а не молчаливая
 * потеря и не пропущенная разметка. Чистые функции: ни базы, ни Nest.
 *
 * Блоки (разделитель — пустая строка, смена вида строки тоже начинает блок):
 * `#`, `##`, `###` — заголовок; `- ` или `* ` — список; `1. `, `2. ` —
 * нумерованный список; `> ` — цитата; `|…|` с разделителем `|---|` второй
 * строкой — таблица; `<details>`, `<summary>текст</summary>`, … `</details>`
 * на своих строках — раскрывающийся блок до трёх уровней; `---` — разделитель;
 * прочее — абзац. Внутри строки: `**жирный**`, `_курсив_`, `[текст](https://…)`;
 * `\` перед `* _ [ ] ( ) # > | < \ -` оставляет знак как есть. Отступов и
 * вложенных списков нет: отступ перед разметкой — ошибка.
 */

export const BROADCAST_RICH_LIMITS = {
  /** блоков на рассылку, вложенные в `<details>` — тоже */
  blocks: 100,
  /** знаков в исходнике — как у простой рассылки (потолок сообщения Telegram) */
  sourceChars: 4_096,
  /** сколько `<details>` может лежать друг в друге */
  detailsDepth: 3,
} as const;

/** Отказ запуска оформленной рассылки без теста себе той же редакции (говорят одно и сервис, и хранилище). */
export const BROADCAST_NOT_TESTED_MESSAGE = "Оформленную рассылку запускают после теста себе этой же редакции";

export interface BroadcastRichParse {
  doc: RichDocument;
  /** ошибки по-русски, по порядку строк; пустой список — документ годен к отправке */
  problems: string[];
}

/** Отпечаток редакции: формат, текст и кнопка. Тест себе записывает его, запуск сверяет. */
export function editionHash(input: { format: string; text: string; buttonText: string | null }): string {
  return createHash("sha256").update(JSON.stringify([input.format, input.text, input.buttonText])).digest("hex");
}

// --- Строки исходника ---

type LineKind = "blank" | "details" | "endDetails" | "summary" | "divider" | "heading" | "bullet" | "ordered" | "quote" | "table" | "paragraph";

interface Line {
  /** номер строки в исходнике, с единицы */
  no: number;
  kind: LineKind;
  /** строка без пробелов по краям */
  content: string;
  /** после маркера: текст пункта, цитаты, заголовка; у `summary` — внутри тегов */
  body: string;
  /** у заголовка — число `#`, у нумерованного пункта — его номер */
  number: number;
}

/** Ошибки с номером строки; в конце сортируются, чтобы идти по порядку исходника, а не разбора. */
class Problems {
  private readonly list: { line: number; message: string }[] = [];
  add = (line: number, message: string): void => void this.list.push({ line, message });
  at = (line: number, message: string): void => this.add(line, `строка ${String(line)}: ${message}`);
  messages = (): string[] => [...this.list].sort((a, b) => a.line - b.line).map((problem) => problem.message);
}

const SUMMARY = /^<summary>(.*)<\/summary>$/;
const HEADING = /^(#{1,6})(?:[ \t]+(.*))?$/;
const BULLET = /^[-*](?:[ \t]+(.*))?$/;
const ORDERED = /^(\d{1,3})\.[ \t]+(.*)$/;
const QUOTE = /^>(?:[ \t](.*))?$/;

/** Маркер блока в начале строки без отступа; `null` — обычный текст. */
function markerOf(text: string): Pick<Line, "kind" | "body" | "number"> | null {
  if (text === "---") return { kind: "divider", body: "", number: 0 };
  const heading = HEADING.exec(text);
  if (heading !== null) return { kind: "heading", body: (heading[2] ?? "").trim(), number: (heading[1] ?? "").length };
  const bullet = BULLET.exec(text);
  if (bullet !== null) return { kind: "bullet", body: (bullet[1] ?? "").trim(), number: 0 };
  const ordered = ORDERED.exec(text);
  if (ordered !== null) return { kind: "ordered", body: (ordered[2] ?? "").trim(), number: Number(ordered[1]) };
  const quote = QUOTE.exec(text);
  if (quote !== null) return { kind: "quote", body: (quote[1] ?? "").trim(), number: 0 };
  return text.startsWith("|") ? { kind: "table", body: text, number: 0 } : null;
}

function classify(no: number, raw: string, problems: Problems): Line {
  const text = raw.trimEnd();
  const content = text.trim();
  const line = (kind: LineKind, body = "", number = 0): Line => ({ no, kind, content, body, number });
  if (content === "") return line("blank");
  // Теги разрешены с отступом: автор вправе сдвинуть содержимое <details>.
  if (content === "<details>") return line("details");
  if (content === "</details>") return line("endDetails");
  const summary = SUMMARY.exec(content);
  if (summary !== null) return line("summary", (summary[1] ?? "").trim());

  const indented = text !== text.trimStart();
  const marker = markerOf(indented ? content : text);
  if (marker === null) return line("paragraph", content);
  if (!indented) return line(marker.kind, marker.body, marker.number);
  // Молча сплющить вложенный список нельзя: смысл строки изменился бы.
  problems.at(no, "отступ перед разметкой не поддерживается — вложенных списков и цитат нет");
  return line("paragraph", content);
}

/** Управляющие символы (кроме табуляции) и переопределение направления текста: им нечего делать в рассылке. */
const FORBIDDEN_CHAR = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
const hasForbiddenChar = (line: string): boolean => FORBIDDEN_CHAR.test(line.replaceAll("\t", ""));

// --- Разметка внутри строки ---

class MarkupError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

type Stop = "root" | "bold" | "italic" | "link";

const ESCAPABLE = new Set(["*", "_", "[", "]", "(", ")", "#", ">", "|", "<", "\\", "-"]);
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const SPACE_CHAR = /\s/;
const UNCLOSED: Record<Exclude<Stop, "root">, string> = { bold: "незакрытый **", italic: "незакрытый _", link: "незакрытая [" };
const TAG_START = /[A-Za-z/!?]/;
const TAG_NAME = /^<\/?([A-Za-z][A-Za-z0-9-]*)/;

function collapse(parts: RichText[]): RichText {
  const [first] = parts;
  if (first === undefined) return "";
  return parts.length === 1 ? first : parts;
}

/**
 * Спуск по тексту: `**`, `_` и `[` открывают свой уровень, он же закрывается
 * своим знаком. Уровень в самого себя не вкладывается, а пересечение вида
 * `**а _б** в_` — ошибка.
 */
class InlineParser {
  private pos = 0;

  constructor(
    private readonly source: string,
    private readonly lineAt: (position: number) => number,
  ) {}

  parse(): RichText {
    return this.run("root", [], 0);
  }

  private fail(position: number, message: string): never {
    throw new MarkupError(this.lineAt(position), message);
  }

  private run(stop: Stop, open: readonly Stop[], openedAt: number): RichText {
    const source = this.source;
    const parts: RichText[] = [];
    let text = "";
    const flush = (): void => {
      if (text !== "") parts.push(text);
      text = "";
    };
    const done = (): RichText => {
      flush();
      return collapse(parts);
    };
    /** Закрывающий знак чужого уровня, открытого выше: уровень внутри него не закрыт. */
    const crossed = (): never => this.fail(openedAt, stop === "root" ? "разметка пересекается" : UNCLOSED[stop]);
    /** Выделение внутри текущего уровня; пустое — ошибка. */
    const emphasis = (kind: "bold" | "italic", at: number, size: number): void => {
      flush();
      this.pos += size;
      const inner = this.run(kind, [...open, kind], at);
      if (inner === "") this.fail(at, kind === "bold" ? "пустое выделение **" : "пустое выделение _");
      parts.push({ kind, text: inner });
    };

    while (this.pos < source.length) {
      const at = this.pos;
      const char = source.charAt(at);

      if (char === "\\") {
        const next = source.charAt(at + 1);
        const escaped = next !== "" && ESCAPABLE.has(next);
        text += escaped ? next : char;
        this.pos += escaped ? 2 : 1;
      } else if (char === "*") {
        if (source.charAt(at + 1) !== "*") this.fail(at, "одиночная * — для курсива пишите _текст_, для самой звёздочки — \\*");
        if (stop === "bold") {
          this.pos += 2;
          return done();
        }
        if (open.includes("bold")) crossed();
        emphasis("bold", at, 2);
      } else if (char === "_") {
        // Подчёркивание внутри слова и в адресе — просто текст: snake_case, t.me/my_channel.
        const previous = at > 0 ? source.charAt(at - 1) : "";
        const next = source.charAt(at + 1);
        const canOpen = next !== "" && !SPACE_CHAR.test(next) && !WORD_CHAR.test(previous);
        const canClose = previous !== "" && !SPACE_CHAR.test(previous) && !WORD_CHAR.test(next);
        if (stop === "italic" && canClose) {
          this.pos += 1;
          return done();
        }
        if (open.includes("italic") && canClose) crossed();
        if (canOpen) {
          if (open.includes("italic")) this.fail(at, "курсив внутри курсива не поддерживается");
          emphasis("italic", at, 1);
        } else {
          text += char;
          this.pos += 1;
        }
      } else if (char === "[") {
        if (open.includes("link")) this.fail(at, "вложенная [ — для самой скобки пишите \\[");
        flush();
        this.pos += 1;
        const label = this.run("link", [...open, "link"], at);
        if (label === "") this.fail(at, "пустой текст ссылки");
        if (source.charAt(this.pos) !== "(") this.fail(at, "после ] нужна ссылка: [текст](https://…)");
        const end = source.indexOf(")", this.pos + 1);
        if (end < 0) this.fail(at, "незакрытая ( в ссылке");
        const url = source.slice(this.pos + 1, end);
        this.pos = end + 1;
        this.checkUrl(url, at);
        parts.push({ kind: "link", text: label, url });
      } else if (char === "]") {
        if (stop === "link") {
          this.pos += 1;
          return done();
        }
        if (open.includes("link")) crossed();
        this.fail(at, "лишняя ] — для самой скобки пишите \\]");
      } else if (char === "<" && TAG_START.test(source.charAt(at + 1))) {
        const name = TAG_NAME.exec(source.slice(at, at + 40))?.[1];
        if (name === "details" || name === "summary") this.fail(at, "<details> и <summary> пишутся на отдельных строках");
        this.fail(at, `тег ${name === undefined ? source.slice(at, at + 4) : `<${name}>`} не поддерживается — из HTML разрешены только <details> и <summary>`);
      } else {
        text += char;
        this.pos += 1;
      }
    }

    // Конец текста: корню закрывать нечем, остальным уровням не хватает своего знака.
    if (stop !== "root") this.fail(openedAt, UNCLOSED[stop]);
    return done();
  }

  /** Только https, без пробелов и логина с паролем: `https://t.me@evil.example` ведёт не туда, куда читается. */
  private checkUrl(url: string, at: number): void {
    if (!url.startsWith("https://")) this.fail(at, `ссылка должна начинаться с https://: ${url.slice(0, 60)}`);
    if (/[\s\p{Cc}]/u.test(url)) this.fail(at, "в адресе ссылки не должно быть пробелов");
    if (!URL.canParse(url)) this.fail(at, "некорректный адрес ссылки");
    const parsed = new URL(url);
    if (parsed.username !== "" || parsed.password !== "") this.fail(at, "в адресе ссылки не должно быть логина и пароля");
  }
}

/** Текст блока из строк `{no, text}`. Ошибка уходит в список, а блок остаётся простым текстом. */
function inline(parts: readonly { no: number; text: string }[], problems: Problems): RichText {
  const source = parts.map((part) => part.text).join("\n");
  const lineAt = (position: number): number => {
    let found = parts[0]?.no ?? 0;
    let start = 0;
    for (const part of parts) {
      if (start <= position) found = part.no;
      start += part.text.length + 1;
    }
    return found;
  };
  try {
    return new InlineParser(source, lineAt).parse();
  } catch (error: unknown) {
    if (!(error instanceof MarkupError)) throw error;
    problems.at(error.line, error.message);
    return source;
  }
}

// --- Блоки ---

const LEVELS: Record<number, 1 | 2 | 3 | undefined> = { 1: 1, 2: 2, 3: 3 };
const TABLE_SEPARATOR = /^-{3,}$/;

const paragraphOf = (lines: readonly Line[]): RichBlock => ({ kind: "paragraph", text: lines.map((line) => line.content).join("\n") });
const textOf = (line: Line): { no: number; text: string } => ({ no: line.no, text: line.body });

/** Конец серии подряд идущих строк, подходящих под условие. */
function runEnd(lines: readonly Line[], start: number, accepts: (line: Line) => boolean): number {
  let end = start;
  while (end < lines.length && accepts(lines[end] as Line)) end++;
  return end;
}

/** Ячейки строки таблицы между неэкранированными чертами; `null` — строка не закрыта чертой. */
function splitRow(content: string): string[] | null {
  const cells: string[] = [];
  let current = "";
  let closed = false;
  for (let index = 1; index < content.length; index++) {
    const char = content.charAt(index);
    closed = char === "|";
    if (closed) {
      cells.push(current);
      current = "";
    } else if (char === "\\" && index + 1 < content.length) {
      current += char + content.charAt(++index);
    } else {
      current += char;
    }
  }
  return closed ? cells : null;
}

interface TableRow {
  line: Line;
  cells: string[];
}

function parseTable(rows: readonly Line[], problems: Problems): RichBlock {
  const first = rows[0] as Line;
  const split: TableRow[] = [];
  for (const line of rows) {
    const cells = splitRow(line.content);
    if (cells === null) {
      problems.at(line.no, "строка таблицы должна начинаться и заканчиваться знаком |");
      return paragraphOf(rows);
    }
    split.push({ line, cells });
  }
  const head = split[0] as TableRow;
  const separator = split[1]?.cells;
  if (separator === undefined || separator.length !== head.cells.length || !separator.every((cell) => TABLE_SEPARATOR.test(cell.trim()))) {
    problems.add(first.no + 1, `таблица: нет строки-разделителя |---| после заголовка (строка ${String(first.no + 1)})`);
    return paragraphOf(rows);
  }
  const body = split.slice(2);
  const ragged = body.find((row) => row.cells.length !== head.cells.length);
  if (ragged !== undefined) {
    problems.add(ragged.line.no, `таблица: ряды разной длины (строка ${String(ragged.line.no)})`);
    return paragraphOf(rows);
  }
  const cellsOf = (row: TableRow): RichText[] => row.cells.map((cell) => inline([{ no: row.line.no, text: cell.trim() }], problems));
  return { kind: "table", header: cellsOf(head), rows: body.map(cellsOf) };
}

/** Строка закрывающего `</details>` для открывающего в `from`, с учётом вложенных; -1 — не закрыт. */
function closingOf(lines: readonly Line[], from: number): number {
  let level = 0;
  for (let index = from; index < lines.length; index++) {
    const kind = lines[index]?.kind;
    if (kind === "details") level++;
    if (kind === "endDetails" && --level === 0) return index;
  }
  return -1;
}

/** Абзац: прочие строки подряд, в том числе «15. ноября…» без списка перед ними. */
function parseParagraph(lines: readonly Line[], start: number, problems: Problems): { block: RichBlock; end: number } {
  const end = runEnd(lines, start, (line) => line.kind === "paragraph" || (line.kind === "ordered" && line.number !== 1));
  const run = lines.slice(start, end);
  return { block: { kind: "paragraph", text: inline(run.map((line) => ({ no: line.no, text: line.content })), problems) }, end };
}

function parseBlocks(lines: readonly Line[], depth: number, problems: Problems): RichBlock[] {
  const blocks: RichBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as Line;
    const same = (kind: LineKind): number => runEnd(lines, index, (candidate) => candidate.kind === kind);
    let end = index + 1;
    switch (line.kind) {
      case "divider":
        blocks.push({ kind: "divider" });
        break;

      case "heading": {
        const level = LEVELS[line.number];
        if (level === undefined) {
          problems.at(line.no, "заголовки бывают трёх уровней: #, ## и ###");
          blocks.push(paragraphOf([line]));
        } else if (line.body === "") problems.at(line.no, "пустой заголовок");
        else blocks.push({ kind: "heading", level, text: inline([textOf(line)], problems) });
        break;
      }
      case "bullet": {
        end = same("bullet");
        const items: RichText[] = [];
        for (const item of lines.slice(index, end)) {
          if (item.body === "") problems.at(item.no, "пустой пункт списка");
          else items.push(inline([textOf(item)], problems));
        }
        if (items.length > 0) blocks.push({ kind: "list", items });
        break;
      }
      case "ordered": {
        // Список начинается с «1.»; «15. ноября…» в начале абзаца — обычный текст.
        if (line.number !== 1) {
          const paragraph = parseParagraph(lines, index, problems);
          blocks.push(paragraph.block);
          end = paragraph.end;
          break;
        }
        end = same("ordered");
        const numbering = lines.slice(index, end).findIndex((item, position) => item.number !== position + 1);
        const wrong = lines[index + numbering];
        if (numbering >= 0 && wrong !== undefined) problems.at(wrong.no, `нумерация списка должна идти подряд — ожидалось ${String(numbering + 1)}`);
        blocks.push({ kind: "list", ordered: true, items: lines.slice(index, end).map((item) => inline([textOf(item)], problems)) });
        break;
      }
      case "quote": {
        end = same("quote");
        const quoted = lines.slice(index, end);
        while (quoted[0]?.body === "") quoted.shift();
        while (quoted.at(-1)?.body === "") quoted.pop();
        if (quoted.length === 0) problems.at(line.no, "пустая цитата");
        else blocks.push({ kind: "quote", text: inline(quoted.map(textOf), problems) });
        break;
      }
      case "table":
        end = same("table");
        blocks.push(parseTable(lines.slice(index, end), problems));
        break;

      case "details": {
        const close = closingOf(lines, index);
        if (close < 0) {
          // Всё до конца текста — внутри незакрытого блока: разбирать нечего.
          problems.at(line.no, "незакрытый <details>");
          return blocks;
        }
        end = close + 1;
        if (depth + 1 > BROADCAST_RICH_LIMITS.detailsDepth) {
          problems.at(line.no, `<details> вложены глубже ${String(BROADCAST_RICH_LIMITS.detailsDepth)} уровней`);
          break;
        }
        const next = lines[index + 1];
        const hasSummary = next?.kind === "summary";
        if (!hasSummary) problems.at(line.no, "сразу после <details> нужна строка <summary>текст</summary>");
        if (hasSummary && next.body === "") problems.at(next.no, "пустой заголовок в <summary>");
        const summary = hasSummary && next.body !== "" ? inline([textOf(next)], problems) : "";
        blocks.push({ kind: "details", summary, blocks: parseBlocks(lines.slice(index + (hasSummary ? 2 : 1), close), depth + 1, problems) });
        break;
      }
      case "endDetails":
        problems.at(line.no, "лишний </details>");
        break;

      case "summary":
        problems.at(line.no, "<summary> допустим только сразу после <details>");
        break;

      case "paragraph": {
        const paragraph = parseParagraph(lines, index, problems);
        blocks.push(paragraph.block);
        end = paragraph.end;
        break;
      }
      case "blank":
        break;
    }
    index = end;
  }
  return blocks;
}

const countBlocks = (blocks: readonly RichBlock[]): number => blocks.reduce((sum, block) => sum + 1 + (block.kind === "details" ? countBlocks(block.blocks) : 0), 0);

/**
 * Исходник из панели → документ и ошибки. Не бросает: на любом входе
 * возвращает документ (блок с ошибкой остаётся простым текстом — предпросмотр
 * не пустеет) и список ошибок; к отправке документ годен, только когда он пуст.
 */
export function parseBroadcastMarkdown(source: string): BroadcastRichParse {
  if (source.length > BROADCAST_RICH_LIMITS.sourceChars) {
    return { doc: { blocks: [] }, problems: [`исходник длиннее ${String(BROADCAST_RICH_LIMITS.sourceChars)} знаков: ${String(source.length)}`] };
  }
  const normalized = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (normalized.trim() === "") return { doc: { blocks: [] }, problems: ["пустой текст рассылки"] };

  const problems = new Problems();
  const lines = normalized.split("\n").map((raw, index) => {
    if (hasForbiddenChar(raw)) problems.at(index + 1, "недопустимый управляющий символ");
    return classify(index + 1, raw, problems);
  });
  const doc: RichDocument = { blocks: parseBlocks(lines, 0, problems) };

  const messages = problems.messages();
  const count = countBlocks(doc.blocks);
  if (count > BROADCAST_RICH_LIMITS.blocks) messages.push(`блоков больше ${String(BROADCAST_RICH_LIMITS.blocks)}: ${String(count)}`);
  // Всё, что порт не пропустит к отправке: ссылки, ширина таблицы, простой текст до 4 000 знаков.
  for (const problem of richProblems(doc)) if (!messages.includes(problem)) messages.push(problem);
  return { doc, problems: messages };
}
