import { useEffect, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { t } from "../../i18n";
import { retryConnection, useConnection } from "../../state/connection";
import { Button } from "./Button";

/**
 * Общая плашка «Нет связи с сервером» (tasks/T-0015): одна на всё приложение,
 * её рисует `Screen`, экраны ничего для этого не делают. Объясняет, что
 * работает (забег) и что вернётся вместе со связью, и даёт проверить её сразу.
 * Собственные ошибки экранов остаются для случая, когда сервер ответил.
 *
 * Прилипает под шапкой разделов и не уезжает при прокрутке: отступ шапки уже
 * есть у прокрутки, поэтому `top-0` отсчитывается от него. Появляется и
 * скрывается прозрачностью (`docs/27-design-system-and-app-shell.md` §3.3):
 * на время затухания плашка остаётся в разметке.
 */
const FADE_OUT_MS = 250;

export function ConnectionBanner(): ReactNode {
  const offline = useConnection((state) => state.status === "offline");
  const checking = useConnection((state) => state.checking);
  // `mounted` держит плашку в разметке, пока она гаснет; `shown` — её прозрачность.
  const [mounted, setMounted] = useState(offline);
  const [shown, setShown] = useState(offline);

  useEffect(() => {
    if (offline) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), FADE_OUT_MS);
    return () => clearTimeout(timer);
  }, [offline]);

  if (!mounted) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`sticky top-0 z-10 -mx-4 px-4 pb-3 transition-opacity duration-(--duration-base) ease-base ${shown ? "opacity-100" : "opacity-0"}`}
    >
      {/* Подложка непрозрачная: прилипшая плашка не должна просвечивать карточками при прокрутке. */}
      <div className="flex items-center gap-2.5 rounded-lg border border-warning/45 bg-[color-mix(in_oklab,var(--color-warning)_10%,var(--color-bg))] px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[13.5px] font-semibold text-text">
            <TriangleAlert size={18} aria-hidden="true" className="shrink-0 text-warning" />
            {t("connection.offline.title")}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">{t("connection.offline.text")}</p>
        </div>
        <span className="shrink-0">
          <Button track="retry" variant="secondary" size="s" disabled={checking} onClick={() => void retryConnection()}>
            {t(checking ? "connection.checking" : "connection.retry")}
          </Button>
        </span>
      </div>
    </div>
  );
}
