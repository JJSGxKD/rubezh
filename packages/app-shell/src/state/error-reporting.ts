import { reportError } from "./shell";

/**
 * Ошибки, до которых не дотянулись обработчики оболочки: необработанные
 * исключения и отклонённые промисы (docs/26-stage2-plan.md, WP8, `client_error`).
 * Ошибки экранов ловит `ScreenBoundary`, ошибки движка приходят событием
 * `error` сессии — сюда попадает остальное.
 *
 * В событие уходит только текст, без стека: стек минифицированной сборки без
 * карт исходников ничего не говорит, а весит как сотня событий.
 */
export function installErrorReporting(target: Window = window): () => void {
  const onError = (event: ErrorEvent): void => {
    // «Script error.» — ошибка чужого скрипта без подробностей: браузер их
    // скрывает. Считаем её, но отличаем от своих.
    const message = event.error instanceof Error ? event.error.message : event.message;
    reportError("window", message === "" ? "без текста" : message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    reportError("promise", reason instanceof Error ? reason.message : String(reason));
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
