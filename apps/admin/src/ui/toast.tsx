import { Toaster as Sonner } from "sonner";

export { toast } from "sonner";

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
