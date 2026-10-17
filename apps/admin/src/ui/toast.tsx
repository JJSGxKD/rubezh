import { Toaster as Sonner, toast } from "sonner";

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
          description: "text-xs text-text-muted",
          success: "border-success/50",
          error: "border-danger/50",
          icon: "mt-0.5",
        },
      }}
    />
  );
}
