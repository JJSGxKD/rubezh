import { useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import {
  BAN_KIND,
  COMMENT_MAX,
  fetchRestrictionCatalog,
  leftText,
  liftRestriction,
  outcomeText,
  STATE_TITLES,
  type Restriction,
} from "../../api/restrictions";
import { formatDateTime } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Field, Loading, Notice, Panel, TextArea } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import type { Loaded } from "../../ui/use-api";
import { RestrictDialog } from "./RestrictDialog";

/**
 * Ограничения игрока в карточке (docs/35-stage4-plan.md WP44): что закрыто
 * сейчас и сколько осталось, кто и почему закрыл, история — и действия:
 * ограничить на срок или снять раньше, с причиной. Блокировка целиком —
 * то же ограничение под правом на блокировку.
 */
export function RestrictionsPanel({
  accountId,
  playerName,
  restrictions,
  onChanged,
}: {
  accountId: string;
  playerName: string;
  restrictions: Loaded<{ restrictions: Restriction[] }>;
  onChanged: () => void;
}) {
  const view = useSession((session) => session.view);
  const canRestrict = can(view, "players.restrict");
  const canBan = can(view, "players.ban");
  const catalog = useApi(() => fetchRestrictionCatalog(api), []);
  const [restricting, setRestricting] = useState(false);
  const [lifting, setLifting] = useState<Restriction | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const now = new Date();

  const canLift = (row: Restriction) => (row.kind === BAN_KIND ? canBan : canRestrict);
  const rows = restrictions.status === "ok" ? restrictions.data.restrictions : [];
  const active = rows.filter((row) => row.state === "active");
  const past = rows.filter((row) => row.state !== "active");

  return (
    <Panel
      title="Ограничения"
      help={HELP.players.restrictions}
      actions={
        (canRestrict || canBan) && catalog.state.status === "ok" ? (
          <Button tone="danger" onClick={() => setRestricting(true)}>
            Ограничить…
          </Button>
        ) : null
      }
    >
      {restrictions.status === "loading" ? <Loading /> : null}
      {restrictions.status === "error" ? <ErrorNotice error={restrictions.error} onRetry={onChanged} /> : null}
      {catalog.state.status === "error" ? <ErrorNotice error={catalog.state.error} onRetry={catalog.reload} /> : null}
      {restrictions.status === "ok" ? (
        <div className="flex flex-col gap-3">
          {active.length === 0 ? (
            <p className="text-sm text-text-muted">Сейчас игроку ничего не закрыто.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {active.map((row) => (
                <li key={row.restrictionId} className={`flex flex-wrap items-start justify-between gap-3 rounded-sm border px-3 py-2.5 ${row.kind === BAN_KIND ? "border-danger/60 bg-danger/5" : "border-border bg-surface-sunken"}`}>
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {row.title}
                      <Badge tone={row.notify ? "info" : "warning"}>{row.notify ? "игрок видит" : "молча"}</Badge>
                    </div>
                    <div className="text-sm">
                      {row.endsAt === null ? "бессрочно" : `до ${formatDateTime(row.endsAt)}`}
                      {row.endsAt === null ? null : <span className="text-text-muted"> · {leftText(row.endsAt, now)}</span>}
                    </div>
                    <div className="text-xs text-text-muted">
                      Причина: {row.reasonTitle}
                      {row.comment === null ? null : <> — «{row.comment}»</>}
                    </div>
                    <div className="text-xs text-text-muted">
                      Закрыл {row.imposedBy?.name ?? "—"} {formatDateTime(row.startsAt)}
                    </div>
                  </div>
                  {canLift(row) ? <Button onClick={() => setLifting(row)}>Снять…</Button> : null}
                </li>
              ))}
            </ul>
          )}
          {past.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              <div>
                <Button onClick={() => setHistoryOpen(!historyOpen)}>{historyOpen ? "Скрыть историю" : `История (${String(past.length)})`}</Button>
              </div>
              {historyOpen ? (
                <DataTable
                  rows={past}
                  rowKey={(row) => row.restrictionId}
                  columns={[
                    { title: "Что", render: (row) => row.title },
                    { title: "Срок", render: (row) => `${formatDateTime(row.startsAt)} — ${row.endsAt === null ? "бессрочно" : formatDateTime(row.endsAt)}` },
                    { title: "Причина", render: (row) => (row.comment === null ? row.reasonTitle : `${row.reasonTitle} — «${row.comment}»`) },
                    { title: "Закрыл", render: (row) => `${row.imposedBy?.name ?? "—"}${row.notify ? "" : " (молча)"}` },
                    { title: "Чем кончилось", render: (row) => <span title={STATE_TITLES[row.state] ?? row.state}>{outcomeText(row)}</span> },
                  ]}
                />
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      {catalog.state.status === "ok" ? (
        <RestrictDialog
          open={restricting}
          onOpenChange={setRestricting}
          playerName={playerName}
          accountId={accountId}
          catalog={catalog.state.data}
          active={active}
          canBan={canBan}
          canRestrict={canRestrict}
          onDone={onChanged}
        />
      ) : null}
      <LiftDialog row={lifting} onClose={() => setLifting(null)} onDone={onChanged} />
    </Panel>
  );
}

/** Снять раньше срока — с причиной: она остаётся в истории и в аудите. */
function LiftDialog({ row, onClose, onDone }: { row: Restriction | null; onClose: () => void; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const close = () => {
    setComment("");
    setError(null);
    onClose();
  };

  const lift = async () => {
    if (row === null) return;
    setPending(true);
    setError(null);
    const result = await liftRestriction(api, row.restrictionId, comment.trim());
    setPending(false);
    if (!result.ok) return setError(result.error);
    toast.success(row.kind === BAN_KIND ? "Блокировка снята" : "Ограничение снято", { description: `${row.title} — игроку снова доступно` });
    close();
    onDone();
  };

  const ban = row?.kind === BAN_KIND;
  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => (open ? undefined : close())}
      title={ban ? "Снять блокировку" : `Снять ограничение «${row?.title ?? ""}»`}
      description={ban ? "Игрок сможет войти сразу; сессии, отозванные при блокировке, не вернутся — он войдёт заново." : "Игроку сразу станет доступно то, что было закрыто."}
      footer={
        <>
          <Button onClick={close}>Отмена</Button>
          <Button tone="primary" disabled={comment.trim() === "" || pending} onClick={() => void lift()}>
            {pending ? "Снимаем…" : "Снять"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {row === null ? null : (
          <p className="text-sm text-text-muted">
            Действует {row.endsAt === null ? "бессрочно" : `до ${formatDateTime(row.endsAt)}`}, причина: {row.reasonTitle}
            {row.comment === null ? "" : ` — «${row.comment}»`}.
          </p>
        )}
        <Field label="Почему снимаете" hint="Останется в истории ограничений и в журнале аудита. Игрок её не увидит.">
          <TextArea rows={3} maxLength={COMMENT_MAX} value={comment} placeholder="Например: разобрались — аккаунты разных людей" onChange={(event) => setComment(event.target.value)} />
        </Field>
        {error === null ? null : <Notice>{error.message}</Notice>}
      </div>
    </Dialog>
  );
}
