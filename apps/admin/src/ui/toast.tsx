import { Toaster as Sonner, toast } from "sonner";
import { errorCopyText, errorDetails, type ApiError } from "../api/client";

export { toast };

/** Сколько висит уведомление с «Отменить», мс. */
export const UNDO_WINDOW_MS = 8000;

/**
 * Обратимое действие сделано: уведомление на 8 секунд с «Отменить».
 * Запрос не задерживается — отмена это обратная операция вызывающего, поэтому
 * закрытая вкладка ничего не теряет и не обманывает.
 */
export function toastWithUndo(text: string, undo: () => Promise<void>): void {
  toast.success(text, {
    duration: UNDO_WINDOW_MS,
    action: {
      label: "Отменить",
      onClick: () => {
        undo().then(
          () => toast("Отменено"),
          () => toast.error("Не удалось отменить — сделайте обратное вручную"),
        );
      },
    },
  });
}

/** Сколько висит ошибка запроса, мс: строку подробностей успевают скопировать. */
export const ERROR_TOAST_MS = 12_000;

/** Копирует текст ошибки целиком; буфер недоступен — просит выделить вручную. */
export function copyErrorDetails(error: ApiError): void {
  navigator.clipboard.writeText(errorCopyText(error, Date.now())).then(
    () => toast("Скопировано"),
    () => toast.error("Браузер не дал скопировать — выделите вручную"),
  );
}

/**
 * Ошибка запроса: текст сервера заголовком, ниже серым — причина (если сервер
 * её отдал) и строка «код · статус · №номер», рядом «Скопировать». `title`
 * заменяет текст сервера, когда экран приписывает к нему своё («Сеть: …»).
 */
export function toastError(error: ApiError, title?: string): void {
  const details = errorDetails(error);
  if (details === null && error.reason === null) {
    toast.error(title ?? error.message, { duration: ERROR_TOAST_MS });
    return;
  }
  toast.error(title ?? error.message, {
    duration: ERROR_TOAST_MS,
    description: (
      <>
        {error.reason === null ? null : <span className="block">{error.reason}</span>}
        {details === null ? null : <span className="block break-all font-mono">{details}</span>}
      </>
    ),
    action: { label: "Скопировать", onClick: () => copyErrorDetails(error) },
  });
}

/**
 * Уведомления об исходе действия (sonner): «сохранено» и «сервер отказал»
 * всплывают в углу и не сдвигают форму, на которую смотрит человек. Вид — из
 * токенов панели, а не из библиотеки.
 */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      duration={6000}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "flex w-[380px] items-start gap-2 rounded-sm border border-border-strong bg-surface-raised px-3 py-2.5 text-sm text-text shadow-panel",
          title: "font-medium",
          description: "min-w-0 text-xs text-text-muted",
          actionButton: "ml-auto shrink-0 rounded-sm border border-border px-2 py-1 text-xs hover:border-border-strong",
          success: "border-success/50",
          error: "border-danger/50",
          icon: "mt-0.5",
        },
      }}
    />
  );
}
