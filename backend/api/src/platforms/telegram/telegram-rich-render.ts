import type { InputRichBlock, InputRichBlockListItem, RichBlockTableCell, RichMessageButton, RichText as TelegramRichText } from "grammy/types";
import type { RichBlock, RichButton, RichDocument, RichText } from "../ports/rich-message.js";
import type { TelegramRichMessage } from "./telegram-rich-api.js";

/**
 * Перевод документа порта (`ports/rich-message.ts`) в тело `sendRichMessage`
 * (Р199). Единственное место, которое знает названия блоков Telegram: домен
 * строит документ, не зная их. Документ перед этим проверяется
 * `richProblems` — здесь пределы не проверяются.
 */

type Block = InputRichBlock;

function textOf(text: RichText): TelegramRichText {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return (text as readonly RichText[]).map(textOf);
  const span = text as Exclude<RichText, string | readonly RichText[]>;
  switch (span.kind) {
    case "bold":
      return { type: "bold", text: textOf(span.text) };
    case "italic":
      return { type: "italic", text: textOf(span.text) };
    case "link":
      return { type: "url", text: textOf(span.text), url: span.url };
    case "dateTime":
      return { type: "date_time", text: span.fallback, unix_time: span.unix, date_time_format: span.format };
  }
}

function paragraphOf(text: RichText): Block {
  return { type: "paragraph", text: textOf(text) };
}

function cellOf(text: RichText, header: boolean): RichBlockTableCell {
  return { text: textOf(text), ...(header ? { is_header: true as const } : {}), align: "left", valign: "top" };
}

function buttonOf(button: RichButton): RichMessageButton {
  return "url" in button ? { text: button.text, url: button.url } : { text: button.text, callback_data: button.action };
}

function itemsOf(items: readonly RichText[], ordered: boolean): InputRichBlockListItem[] {
  return items.map((item, index) => ({ blocks: [paragraphOf(item)], ...(ordered ? { value: index + 1, type: "1" as const } : {}) }));
}

function blockOf(block: RichBlock): Block {
  switch (block.kind) {
    case "heading":
      return { type: "heading", text: textOf(block.text), size: block.level ?? 2 };
    case "paragraph":
      return paragraphOf(block.text);
    case "footer":
      return { type: "footer", text: textOf(block.text) };
    case "divider":
      return { type: "divider" };
    case "list":
      return { type: "list", items: itemsOf(block.items, block.ordered === true) };
    case "table":
      return {
        type: "table",
        cells: [...(block.header === undefined ? [] : [block.header.map((cell) => cellOf(cell, true))]), ...block.rows.map((row) => row.map((cell) => cellOf(cell, false)))],
        is_striped: true,
      };
    case "details":
      return { type: "details", summary: textOf(block.summary), blocks: block.blocks.map(blockOf) };
    case "quote":
      return { type: "blockquote", blocks: [paragraphOf(block.text)] };
    case "photo":
      return {
        type: "photo",
        photo: { type: "photo", media: "fileId" in block.photo ? block.photo.fileId : block.photo.url },
        ...(block.caption === undefined ? {} : { caption: { text: textOf(block.caption) } }),
      };
    case "buttons":
      return { type: "buttons", buttons: block.buttons.map(buttonOf) };
  }
}

export function toTelegramRich(doc: RichDocument): TelegramRichMessage {
  return { blocks: doc.blocks.map(blockOf) };
}
