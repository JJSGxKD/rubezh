export interface CopyResult {
  ok: boolean;
  /** текст для показа на экране устройства — консоли под рукой нет */
  message: string;
}

/**
 * Копирование отчёта в буфер обмена.
 *
 * В WebView Telegram на Android `navigator.clipboard` часто недоступен или
 * молча отклоняет запись — на этом и сорвалось копирование во время первых
 * прогонов. Поэтому путей три, по убыванию надёжности, и последний вообще не
 * требует разрешений: показать текст, который человек выделит сам.
 */
export async function copyText(text: string): Promise<CopyResult> {
  const clipboard = globalThis.navigator?.clipboard;

  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text);
      return { ok: true, message: "Отчёт скопирован в буфер обмена" };
    } catch {
      // Разрешение не дано или контекст не защищённый — пробуем старый способ.
      // Отдельного сообщения здесь не нужно: важен итог, а не какой из путей
      // сработал.
    }
  }

  return copyViaTextarea(text);
}

/**
 * Способ до Clipboard API: невидимое поле, выделение, `execCommand`.
 * Метод объявлен устаревшим, но в старых WebView он единственный работающий,
 * а стенд обязан работать и там.
 */
function copyViaTextarea(text: string): CopyResult {
  if (typeof document === "undefined") {
    return { ok: false, message: "Буфер обмена недоступен" };
  }

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
    const copied = document.execCommand("copy");
    return copied
      ? { ok: true, message: "Отчёт скопирован в буфер обмена" }
      : { ok: false, message: "Буфер обмена недоступен — откройте отчёт кнопкой JSON" };
  } catch (error: unknown) {
    return {
      ok: false,
      message: `Скопировать не вышло: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    field.remove();
  }
}

/**
 * Последний рубеж: показать отчёт поверх канвы в поле, из которого его можно
 * выделить и скопировать руками. Нужен ровно для случая, когда буфер обмена
 * закрыт, а отчёт не ушёл на сервер — иначе трёхминутный прогон пропадает
 * впустую.
 */
export function showReportOverlay(text: string): void {
  if (typeof document === "undefined") return;

  const existing = document.getElementById("bh-bench-overlay");
  if (existing !== null) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "bh-bench-overlay";
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:9999",
    "background:#0d0f14",
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    "padding:12px",
    "box-sizing:border-box",
  ].join(";");

  const hint = document.createElement("div");
  hint.textContent = "Выделите текст и скопируйте вручную";
  hint.style.cssText = "color:#cfd6e4;font:14px monospace";

  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.cssText =
    "flex:1;width:100%;box-sizing:border-box;background:#11141b;color:#cfd6e4;font:12px monospace;border:1px solid #2a3040";

  const close = document.createElement("button");
  close.textContent = "Закрыть";
  close.style.cssText =
    "padding:10px;background:#6ee7a8;color:#0d0f14;border:0;font:16px monospace";
  close.addEventListener("click", () => overlay.remove());

  overlay.append(hint, field, close);
  document.body.appendChild(overlay);
  field.focus();
  field.select();
}
