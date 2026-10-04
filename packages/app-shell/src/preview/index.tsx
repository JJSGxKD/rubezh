import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../design-system/fonts.css";
import "../design-system/tokens.css";
import { t } from "../i18n";
import "../i18n/preview";
import { draftMessageSchema, PREVIEW_READY, type PreviewKind } from "./protocol";
import { PREVIEW_REGISTRY, type PreviewContext } from "./registry";

/**
 * Страница предпросмотра для панели (docs/35-stage4-plan.md WP32, Р83):
 * рисует черновик из панели тем же компонентом, что игрок. Черновик
 * принимается только от адресов панели и только от окна, в которое
 * страница встроена; сеть и вход ей не нужны.
 */
export interface PreviewOptions extends PreviewContext {
  container: HTMLElement;
  /** адреса панели: от остальных сообщения не принимаются, им же уходит «готова» */
  allowedOrigins: readonly string[];
}

export function mountPreview(options: PreviewOptions): void {
  createRoot(options.container).render(
    <StrictMode>
      <PreviewRoot {...options} />
    </StrictMode>,
  );
}

/** Можно ли принять сообщение: от панели и от того окна, что встроило страницу. */
export function trustedMessage(event: Pick<MessageEvent, "origin" | "source">, allowedOrigins: readonly string[], parent: unknown): boolean {
  return allowedOrigins.includes(event.origin) && event.source === parent;
}

function PreviewRoot(props: PreviewOptions): ReactNode {
  const [shown, setShown] = useState<{ kind: PreviewKind; draft: unknown } | null>(null);
  const { allowedOrigins } = props;

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!trustedMessage(event, allowedOrigins, window.parent)) return;
      const parsed = draftMessageSchema.safeParse(event.data);
      if (parsed.success) setShown({ kind: parsed.data.kind, draft: parsed.data.draft });
    };
    window.addEventListener("message", onMessage);
    // Чужому адресу сообщение не дойдёт: браузер сверяет адрес получателя сам.
    if (window.parent !== window) for (const origin of allowedOrigins) window.parent.postMessage({ type: PREVIEW_READY }, origin);
    return () => window.removeEventListener("message", onMessage);
  }, [allowedOrigins]);

  const content = shown === null ? null : PREVIEW_REGISTRY[shown.kind].render(shown.draft, { apiBaseUrl: props.apiBaseUrl });
  return (
    <div className="bg-app min-h-full px-4 pt-3">
      {content ?? <p className="py-6 text-center text-sm text-text-muted">{t(allowedOrigins.length === 0 ? "preview.notConfigured" : "preview.waiting")}</p>}
    </div>
  );
}
