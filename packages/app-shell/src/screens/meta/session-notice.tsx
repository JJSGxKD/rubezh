import type { ReactNode } from "react";
import { CloudOff, KeyRound, ShieldX, Smartphone } from "lucide-react";
import { Button } from "../../design-system/components";
import { t } from "../../i18n";
import { useSession } from "../../state/session";
import { sessionNoticeOf, type SessionNoticeKind, type SessionNoticeView } from "../../state/session-notice";
import { useShell } from "../../state/shell";

/**
 * Почему нет сессии — плашкой там, где без неё пусто: в профиле и рейтинге.
 * Что сказать, решает `state/session-notice.ts`.
 */

/** Есть ли что сказать о сессии — тогда ошибка запроса к серверу лишь повторила бы то же самое. */
export function useSessionNotice(): SessionNoticeView | null {
  const status = useSession((state) => state.status);
  const failure = useSession((state) => state.failure);
  const message = useSession((state) => state.message);
  const auth = useShell((state) => state.capabilities.auth);
  return sessionNoticeOf({ status, failure, message }, auth !== undefined);
}

const ICONS: Record<SessionNoticeKind, typeof CloudOff> = {
  offline: CloudOff,
  stale: KeyRound,
  outside: Smartphone,
  banned: ShieldX,
  rejected: KeyRound,
};

export function SessionNotice(props: { notice: SessionNoticeView }): ReactNode {
  const { notice } = props;
  const Icon = ICONS[notice.kind];
  return (
    <div role="status" className="surface-sunken flex items-start gap-3 rounded-lg px-3 py-2.5">
      <Icon size={18} aria-hidden="true" className={`mt-0.5 shrink-0 ${notice.kind === "banned" ? "text-danger" : "text-warning"}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-muted">{notice.text}</p>
        {notice.retry ? (
          <div className="mt-2">
            <Button variant="secondary" onClick={() => void useSession.getState().signIn()}>
              {t("app.retry")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
