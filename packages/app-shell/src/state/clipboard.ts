/**
 * Копирование текста в буфер обмена.
 *
 * В WebView Telegram на Android `navigator.clipboard` часто недоступен или
 * молча отклоняет запись — на этом срывалось копирование отчётов на прогонах
 * этапа 1. Поэтому путей два, а когда не сработал ни один, экран показывает
 * текст, который человек выделит сам.
 */
const CLIPBOARD_TIMEOUT_MS = 1500;

export async function copyText(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard !== undefined && (await writeWithTimeout(clipboard, text))) return true;
  return copyViaTextarea(text);
}

/**
 * Запрос разрешения на запись в некоторых WebView висит без ответа: без
 * таймаута кнопка «Скопировать» просто ничего бы не делала.
 */
async function writeWithTimeout(clipboard: Clipboard, text: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), CLIPBOARD_TIMEOUT_MS);
  });
  const write = clipboard.writeText(text).then(
    () => true,
    // Разрешение не дано или контекст не защищённый — идём старым способом.
    () => false,
  );
  try {
    return await Promise.race([write, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Способ до Clipboard API: невидимое поле, выделение, `execCommand`. Метод
 * объявлен устаревшим, но в старых WebView он единственный работающий.
 */
function copyViaTextarea(text: string): boolean {
  if (typeof document === "undefined") return false;

  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "true");
  field.style.position = "fixed";
  field.style.top = "-1000px";
  field.style.opacity = "0";
  document.body.appendChild(field);
  try {
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch (error: unknown) {
    console.warn("Копирование через execCommand не удалось:", error);
    return false;
  } finally {
    field.remove();
  }
}
