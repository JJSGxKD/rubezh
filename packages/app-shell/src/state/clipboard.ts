import { useShell } from "./shell";

/**
 * Текст в буфер обмена: средствами площадки, если она умеет, иначе буфером
 * браузера, а где он закрыт (старый WebView, нет разрешения) — выделением
 * скрытого поля и командой копирования. `false` — не вышло ничего: игрок
 * должен узнать, что ссылка не скопировалась, а не искать её в буфере.
 *
 * Запасной путь — свой, а не `copyTextToClipboard` из SDK Telegram: адаптер
 * лежит в первой загрузке, и функция SDK стоила бы ей лишних байт ради кнопки
 * на экране друзей.
 */
export async function copyText(text: string): Promise<boolean> {
  const adapter = useShell.getState().adapter;
  if (adapter.copyText !== undefined) return await adapter.copyText(text);
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Буфер браузера закрыт — пробуем старый путь ниже.
    }
  }
  return copyBySelection(text);
}

function copyBySelection(text: string): boolean {
  if (typeof document === "undefined") return false;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    // Устаревшая, но единственная команда там, где асинхронного буфера нет.
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
