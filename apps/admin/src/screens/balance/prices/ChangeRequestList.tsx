import type { ReactNode } from "react";
import type { ChangeRequest, RequestStatus } from "../../../api/change-requests";
import { formatDateTime } from "../../../format";
import { Badge, Button } from "../../../ui/kit";
import { describeChange, requestActions, requestStatusTitle, timeLeft } from "./prices-rules";

const STATUS_TONES: Record<RequestStatus, "warning" | "success" | "neutral" | "info"> = {
  pending: "warning",
  approved: "success",
  rejected: "neutral",
  expired: "neutral",
  superseded: "neutral",
};

/**
 * Заявки на правку: кто предложил, «было → стало», причина и срок
 * (docs/19-content-admin.md §6, tasks/T-0309). Кнопки зависят от человека:
 * подтвердить и отклонить может только другой участник, у автора — «Отозвать».
 * Карточки, а не таблица: «было → стало» и причина длинные, и на 320 px таблица
 * из шести колонок не читается.
 */
export function ChangeRequestList({
  requests,
  meId,
  now,
  titleOf,
  busy,
  onApprove,
  onReject,
  onWithdraw,
}: {
  requests: readonly ChangeRequest[];
  meId: string;
  now: Date;
  /** название цели правки: «60 самоцветов», а не id */
  titleOf: (kind: string, target: string) => string;
  /** заявка, над которой идёт запрос: её кнопки выключены */
  busy: string | null;
  onApprove: (request: ChangeRequest) => void;
  onReject: (request: ChangeRequest) => void;
  onWithdraw: (request: ChangeRequest) => void;
}): ReactNode {
  if (requests.length === 0) return <p className="text-sm text-text-muted">Заявок пока нет</p>;
  return (
    <ul className="flex flex-col gap-2">
      {requests.map((request) => {
        const actions = requestActions(request, meId, now);
        const disabled = busy === request.requestId;
        const pending = request.status === "pending";
        return (
          <li key={request.requestId} className="flex min-w-0 flex-col gap-2 rounded-sm border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 break-words font-medium">{titleOf(request.kind, request.target)}</span>
              <Badge tone={STATUS_TONES[request.status]}>{requestStatusTitle(request)}</Badge>
              <span className="text-xs text-text-muted">{pending ? timeLeft(request, now) : formatDateTime(request.decidedAt ?? request.createdAt)}</span>
            </div>
            <ul aria-label="Было и стало" className="flex flex-col gap-0.5 text-sm tabular-nums">
              {describeChange(request.kind, request.before, request.after).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="break-words text-sm text-text-muted">«{request.reason}»</p>
            <p className="text-xs text-text-muted">
              Автор: {request.authorName ?? "—"}, {formatDateTime(request.createdAt)}
              {pending || request.decidedBy === null || (request.status === "rejected" && request.decidedBy === request.author) ? null : ` · решил: ${request.decidedByName ?? "—"}`}
            </p>
            {actions.approve || actions.reject || actions.withdraw ? (
              <div className="flex flex-wrap gap-2">
                {actions.approve ? (
                  <Button tone="primary" disabled={disabled} onClick={() => onApprove(request)}>
                    Подтвердить
                  </Button>
                ) : null}
                {actions.reject ? (
                  <Button disabled={disabled} onClick={() => onReject(request)}>
                    Отклонить
                  </Button>
                ) : null}
                {actions.withdraw ? (
                  <Button disabled={disabled} onClick={() => onWithdraw(request)}>
                    Отозвать
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
