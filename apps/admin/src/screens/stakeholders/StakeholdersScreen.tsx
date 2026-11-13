import { useState } from "react";
import { api } from "../../services";
import { canAssignRoles, canManageShares, loadStakeholders, monthFrom, type Participant, type StakeholdersView } from "../../api/stakeholders";
import { formatDateTime, formatNumber } from "../../format";
import { hrefOf } from "../../routes";
import { useSession } from "../../state/use-session";
import { Badge, Button, ErrorNotice, Loading, Notice, Panel } from "../../ui/kit";
import { useApi } from "../../ui/use-api";
import { ShareDialog } from "./ShareDialog";

/**
 * Участники проекта (docs/29-admin-panel.md §6.6, Р217): доли с месяца, будущая доля, история правок и
 * доля владельца — остаток. Менять долю может только владелец (`stakeholders.manage`); финансы видят экран
 * без кнопки.
 */
function ParticipantCard({ participant, canManage, onEdit }: { participant: Participant; canManage: boolean; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const { current, next } = participant;
  return (
    <li className="flex flex-col gap-2 rounded-sm border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="flex min-w-24 flex-1 flex-wrap items-center gap-2 font-medium">
          {participant.name}
          {participant.hasRole ? null : <Badge tone="warning">роли нет</Badge>}
        </span>
        <span className="tabular-nums">
          {current === null ? <span className="text-text-muted">доли нет</span> : `${formatNumber(current.sharePercent)} % с ${monthFrom(current.fromMonth)}`}
          {next === null ? null : <span className="text-text-muted">{` · с ${monthFrom(next.fromMonth)} — ${formatNumber(next.sharePercent)} %`}</span>}
        </span>
        <span className="flex gap-1.5">
          <Button aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Скрыть историю" : "История"}
          </Button>
          {canManage ? (
            <Button aria-label={`Изменить долю: ${participant.name}`} onClick={onEdit}>
              Изменить долю
            </Button>
          ) : null}
        </span>
      </div>
      {open ? (
        participant.history.length === 0 ? (
          <p className="text-sm text-text-muted">Изменений пока не было.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 border-t border-border pt-2 text-sm">
            {participant.history.map((entry) => (
              <li key={`${entry.fromMonth}|${entry.setAt}`} className="flex flex-col gap-0.5">
                <span className="tabular-nums">
                  <b>{formatNumber(entry.sharePercent)} %</b> с {monthFrom(entry.fromMonth)}
                </span>
                {entry.note === undefined ? null : <span className="text-text-muted">{entry.note}</span>}
                <span className="text-xs text-text-muted">
                  {entry.setBy === undefined ? "" : `${entry.setBy} · `}
                  {formatDateTime(entry.setAt)}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </li>
  );
}

function Loaded({ data, onChange }: { data: StakeholdersView; onChange: (next: StakeholdersView) => void }) {
  const view = useSession((session) => session.view);
  const canManage = canManageShares(view);
  const [editing, setEditing] = useState<string | null>(null);
  const target = data.participants.find((participant) => participant.accountId === editing);

  return (
    <>
      <p className="text-sm tabular-nums">
        <b>Владелец — {formatNumber(data.ownerSharePercent)} %</b> · Участников — {data.participants.length}
      </p>
      {data.participants.length === 0 ? (
        <Notice tone="info">
          Участников пока нет. Участник — аккаунт с ролью «Участник проекта»: выдать её можно в разделе «Роли».
          {canAssignRoles(view) ? (
            <>
              {" "}
              <a href={hrefOf({ section: "roles", id: null })} className="text-accent underline-offset-2 hover:underline">
                Открыть «Роли»
              </a>
            </>
          ) : null}
        </Notice>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.participants.map((participant) => (
            <ParticipantCard key={participant.accountId} participant={participant} canManage={canManage} onEdit={() => setEditing(participant.accountId)} />
          ))}
        </ul>
      )}
      {target === undefined ? null : (
        <ShareDialog
          view={data}
          participant={target}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            onChange(next);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

export function StakeholdersScreen() {
  const { state, reload } = useApi(() => loadStakeholders(api), []);
  return (
    <div className="flex flex-col gap-4">
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <Panel title="Доли участников" actions={<Button onClick={reload}>Обновить</Button>}>
          <div className="flex flex-col gap-3">
            <Loaded data={state.data} onChange={reload} />
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
