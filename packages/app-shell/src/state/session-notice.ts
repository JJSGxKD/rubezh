import { t } from "../i18n";
import "../i18n/account";
import type { AuthFailure } from "./auth-api";
import type { SessionState } from "./session";

/**
 * Почему у игрока нет сессии и что с этим делать (docs/34-stage3-plan.md,
 * WP7). Причина разная — и совет разный: «проверь связь» не поможет тому,
 * кто открыл игру мимо Telegram, а заблокированному нужна причина, а не
 * «попробуй позже». Отображение — `screens/meta/session-notice.tsx`.
 *
 * Пока сессия входит, промолчать честнее, чем мигнуть ошибкой, которая через
 * секунду пройдёт.
 */

export type SessionNoticeKind = "offline" | "stale" | "outside" | "banned" | "rejected";

export interface SessionNoticeView {
  kind: SessionNoticeKind;
  /** текст для игрока — всегда из словаря; у блокировки внутри — причина от сервера */
  text: string;
  /** повтор может помочь: пропала сеть или сервер */
  retry: boolean;
}

const KIND_BY_FAILURE: Record<AuthFailure, SessionNoticeKind | null> = {
  offline: "offline",
  unavailable: "offline",
  unauthorized: "stale",
  no_identity: "outside",
  banned: "banned",
  rejected: "rejected",
  // Авторизация выключена в сборке или на сервере: сообщать игроку нечего.
  disabled: null,
};

export function sessionNoticeOf(
  state: Pick<SessionState, "status" | "failure" | "message">,
  authConfigured: boolean,
): SessionNoticeView | null {
  if (!authConfigured || state.status !== "failed" || state.failure === null) return null;
  const kind = KIND_BY_FAILURE[state.failure];
  if (kind === null) return null;
  const text =
    kind === "banned" && state.message !== null && state.message !== ""
      ? t("session.banned.reason", { reason: state.message })
      : t(`session.${kind}`);
  return { kind, text, retry: kind === "offline" };
}
