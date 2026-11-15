/**
 * Оформленное сообщение бота (docs/35-stage4-plan.md Р199, WP52): таблицы,
 * списки, заголовки и кнопки без знания о площадке. Домен строит документ
 * этого вида, а адаптер переводит его в то, что умеет площадка; у площадки без
 * оформления (MAX, VK) и при отказе Telegram уходит `plainTextOf` — тот же
 * документ простым текстом.
 *
 * Файл — порт: ничего не импортирует из модулей и адаптеров.
 */

/** Формат даты в поясе читателя: как у Telegram — `r` (относительно) или набор букв `w`, `d`/`D`, `t`/`T`. */
export type DateTimeFormat = "r" | `${"w" | ""}${"d" | "D" | ""}${"t" | "T" | ""}`;

export type RichText = string | RichSpan | readonly RichText[];

export type RichSpan =
  | { kind: "bold"; text: RichText }
  | { kind: "italic"; text: RichText }
  | { kind: "link"; text: RichText; url: string }
  /** время в поясе читателя; `fallback` — что видит площадка без этой возможности */
  | { kind: "dateTime"; unix: number; format: DateTimeFormat; fallback: string };

export type RichButton = { text: string; url: string } | { text: string; action: string };

export type RichBlock =
  | { kind: "heading"; text: RichText; level?: 1 | 2 | 3 }
  | { kind: "paragraph"; text: RichText }
  | { kind: "list"; items: readonly RichText[]; ordered?: boolean }
  | { kind: "table"; header?: readonly RichText[]; rows: readonly (readonly RichText[])[] }
  | { kind: "details"; summary: RichText; blocks: readonly RichBlock[] }
  | { kind: "quote"; text: RichText }
  | { kind: "photo"; photo: { fileId: string } | { url: string }; caption?: RichText }
  | { kind: "buttons"; buttons: readonly RichButton[] }
  | { kind: "divider" }
  | { kind: "footer"; text: RichText };

export interface RichDocument {
  blocks: readonly RichBlock[];
}

/**
 * Пределы документа. Первые шесть — пределы Telegram; `plainChars` — свой:
 * запасной текст обязан уйти обычным сообщением, а у Telegram оно 4 096 знаков.
 */
export const RICH_LIMITS = { blocks: 500, depth: 16, media: 50, columns: 20, textChars: 32_768, plainChars: 4_000, buttonsPerRow: 8 } as const;

/** Предел `callback_data` у Telegram, байт: длиннее площадка отвечает 400. */
const ACTION_MAX_BYTES = 64;

const BULLET = "• ";
const CELL_SEPARATOR = " · ";
const PARAGRAPH_SEPARATOR = "\n\n";

/** Текст внутри блока. `withUrls` — писать ли адрес ссылки: в простом тексте да, при подсчёте видимого текста нет. */
function inlineOf(text: RichText, withUrls: boolean): string {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return (text as readonly RichText[]).map((part) => inlineOf(part, withUrls)).join("");
  const span = text as RichSpan;
  switch (span.kind) {
    case "bold":
    case "italic":
      return inlineOf(span.text, withUrls);
    case "link": {
      const label = inlineOf(span.text, withUrls);
      return !withUrls || label === span.url ? label : `${label} (${span.url})`;
    }
    case "dateTime":
      return span.fallback;
  }
}

/** Часть простого текста: пробелы по краям обрезаются, пустая часть не оставляет пустой строки между блоками. */
function part(text: string): string[] {
  const trimmed = text.trim();
  return trimmed === "" ? [] : [trimmed];
}

/** Части простого текста одного блока: каждая потом отделяется пустой строкой. */
function partsOf(block: RichBlock, depth: number): string[] {
  switch (block.kind) {
    case "heading":
    case "paragraph":
    case "footer":
      return part(inlineOf(block.text, true));
    case "list":
      return part(block.items.map((item, index) => `${block.ordered === true ? `${String(index + 1)}. ` : BULLET}${inlineOf(item, true).trim()}`).join("\n"));
    case "table": {
      const rows = block.header === undefined ? block.rows : [block.header, ...block.rows];
      return part(rows.map((row) => row.map((cell) => inlineOf(cell, true).trim()).join(CELL_SEPARATOR)).join("\n"));
    }
    case "details":
      return [...part(inlineOf(block.summary, true)), ...partsOfBlocks(block.blocks, depth + 1)];
    case "quote":
      return part(`«${inlineOf(block.text, true).trim()}»`);
    case "photo":
      return block.caption === undefined ? [] : part(inlineOf(block.caption, true));
    case "buttons":
      return part(block.buttons.flatMap((button) => ("url" in button ? [`${button.text}: ${button.url}`] : [])).join("\n"));
    case "divider":
      // Разделитель — пустая строка между соседними блоками, единственная часть без текста.
      return [""];
  }
}

function partsOfBlocks(blocks: readonly RichBlock[], depth: number): string[] {
  // Глубже предела документ всё равно не уйдёт оформленным; обрезаем, чтобы разбор не уронил стек.
  if (depth > RICH_LIMITS.depth) return [];
  return blocks.flatMap((block) => partsOf(block, depth));
}

/**
 * Простой текст документа — для MAX, VK и отказа Telegram: блоки через пустую
 * строку, пометки отбрасываются, ссылка — «текст (адрес)», кнопки действия
 * пропускаются.
 */
export function plainTextOf(doc: RichDocument): string {
  return partsOfBlocks(doc.blocks, 1).join(PARAGRAPH_SEPARATOR).trim();
}

function isHttps(url: string): boolean {
  return url.startsWith("https://") && URL.canParse(url);
}

interface Walk {
  problems: Set<string>;
  blocks: number;
  photos: number;
  visible: number;
}

/** Всё, что в тексте блока надо проверить: адреса ссылок и время. */
function checkInline(text: RichText, walk: Walk): void {
  if (typeof text === "string") return;
  if (Array.isArray(text)) {
    for (const part of text as readonly RichText[]) checkInline(part, walk);
    return;
  }
  const span = text as RichSpan;
  switch (span.kind) {
    case "bold":
    case "italic":
      checkInline(span.text, walk);
      return;
    case "link":
      if (!isHttps(span.url)) walk.problems.add(`Адрес ссылки должен начинаться с https://: ${span.url}`);
      checkInline(span.text, walk);
      return;
    case "dateTime":
      if (!Number.isInteger(span.unix) || span.unix <= 0) walk.problems.add("Время в сообщении должно быть целым положительным числом секунд");
  }
}

function see(text: RichText, walk: Walk): void {
  walk.visible += inlineOf(text, false).length;
  checkInline(text, walk);
}

function checkTable(block: Extract<RichBlock, { kind: "table" }>, walk: Walk): void {
  const widths = new Set([...(block.header === undefined ? [] : [block.header.length]), ...block.rows.map((row) => row.length)]);
  if ([...widths].some((width) => width > RICH_LIMITS.columns)) walk.problems.add(`Таблица: столбцов больше ${String(RICH_LIMITS.columns)}`);
  if (widths.size > 1) walk.problems.add("Таблица: ряды разной длины");
  for (const row of block.header === undefined ? block.rows : [block.header, ...block.rows]) for (const cell of row) see(cell, walk);
}

function checkButtons(block: Extract<RichBlock, { kind: "buttons" }>, walk: Walk): void {
  if (block.buttons.length === 0 || block.buttons.length > RICH_LIMITS.buttonsPerRow) {
    walk.problems.add(`В ряду кнопок должно быть от 1 до ${String(RICH_LIMITS.buttonsPerRow)}`);
  }
  for (const button of block.buttons) {
    walk.visible += button.text.length;
    if ("url" in button) {
      if (!isHttps(button.url)) walk.problems.add(`Адрес кнопки должен начинаться с https://: ${button.url}`);
    } else if (new TextEncoder().encode(button.action).length > ACTION_MAX_BYTES) {
      walk.problems.add(`Действие кнопки длиннее ${String(ACTION_MAX_BYTES)} байт`);
    }
  }
}

function checkBlock(block: RichBlock, depth: number, walk: Walk): void {
  walk.blocks++;
  if (depth > RICH_LIMITS.depth) {
    // Глубже не спускаемся: дерево может быть любой глубины, а стек — нет.
    walk.problems.add(`Слишком глубокая вложенность: больше ${String(RICH_LIMITS.depth)} уровней`);
    return;
  }
  switch (block.kind) {
    case "heading":
    case "paragraph":
    case "footer":
    case "quote":
      see(block.text, walk);
      return;
    case "list":
      for (const item of block.items) see(item, walk);
      return;
    case "table":
      checkTable(block, walk);
      return;
    case "details":
      see(block.summary, walk);
      for (const nested of block.blocks) checkBlock(nested, depth + 1, walk);
      return;
    case "photo":
      walk.photos++;
      if ("url" in block.photo && !isHttps(block.photo.url)) walk.problems.add(`Адрес фото должен начинаться с https://: ${block.photo.url}`);
      if (block.caption !== undefined) see(block.caption, walk);
      return;
    case "buttons":
      checkButtons(block, walk);
      return;
    case "divider":
      return;
  }
}

/** Ошибки документа по-русски; пустой список — документ годен к отправке. */
export function richProblems(doc: RichDocument): string[] {
  const walk: Walk = { problems: new Set(), blocks: 0, photos: 0, visible: 0 };
  for (const block of doc.blocks) checkBlock(block, 1, walk);
  if (walk.blocks > RICH_LIMITS.blocks) walk.problems.add(`Слишком много блоков: ${String(walk.blocks)} при пределе ${String(RICH_LIMITS.blocks)}`);
  if (walk.photos > RICH_LIMITS.media) walk.problems.add(`Слишком много фото: ${String(walk.photos)} при пределе ${String(RICH_LIMITS.media)}`);
  if (walk.visible > RICH_LIMITS.textChars) walk.problems.add("Видимого текста больше 32 768 знаков");
  if (plainTextOf(doc).length > RICH_LIMITS.plainChars) walk.problems.add("Простой текст для запасного сообщения длиннее 4 000 знаков");
  return [...walk.problems];
}
