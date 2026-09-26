import { useState, type FormEvent } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import { fetchAssignments, grantRole, revokeRole, roleName, roleTargetOf, ROLE_NAMES, type Assignment } from "../../api/roles";
import { formatDateTime } from "../../format";
import { Button, DataTable, ErrorNotice, Field, Input, Loading, Notice, Panel, Select } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";

/**
 * Роли команды (docs/29-admin-panel.md §3.2): кому какая выдана и кем.
 * Выдача и снятие — в аудит на сервере; снятая последняя роль гасит сессии
 * панели этого человека сразу.
 */

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

export function RolesScreen() {
  const { state, reload } = useApi(() => fetchAssignments(api), []);
  const [target, setTarget] = useState("");
  const [role, setRole] = useState("moderator");
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [pending, setPending] = useState(false);

  const parsedTarget = roleTargetOf(target);

  const grant = async (event: FormEvent) => {
    event.preventDefault();
    if (parsedTarget === null) return;
    setPending(true);
    const result = await grantRole(api, parsedTarget, role);
    setPending(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: result.data.granted ? `Роль «${roleName(role)}» выдана` : `Роль «${roleName(role)}» уже была` });
    setTarget("");
    reload();
  };

  const revoke = async (assignment: Assignment) => {
    setPending(true);
    const result = await revokeRole(api, { accountId: assignment.accountId }, assignment.role);
    setPending(false);
    setConfirmRevoke(null);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    const sessions = result.data.sessionsRevoked > 0 ? `, закрыто сессий панели: ${result.data.sessionsRevoked}` : "";
    setOutcome({ tone: "success", text: `Роль «${roleName(assignment.role)}» снята${sessions}` });
    reload();
  };

  const keyOf = (assignment: Assignment) => `${assignment.accountId}|${assignment.role}`;

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Выдать роль">
        <form onSubmit={(event) => void grant(event)} className="flex items-end gap-2">
          <Field label="Кому" hint="Telegram ID цифрами или идентификатор аккаунта из карточки игрока">
            <Input value={target} onChange={(event) => setTarget(event.target.value)} className="w-96" maxLength={64} />
          </Field>
          <Field label="Роль">
            <Select value={role} onChange={(event) => setRole(event.target.value)}>
              {ROLE_NAMES.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Button tone="primary" type="submit" disabled={parsedTarget === null || pending}>
            Выдать
          </Button>
        </form>
      </Panel>
      {outcome === null ? null : outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}
      <Panel title="Выданные роли" actions={<Button onClick={reload}>Обновить</Button>}>
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {state.status === "ok" ? (
          <DataTable
            rows={state.data.assignments}
            rowKey={keyOf}
            empty="Ролей в базе нет — владелец пока только из ADMIN_TELEGRAM_IDS"
            columns={[
              {
                title: "Кто",
                render: (row) => (
                  <button type="button" className="text-left hover:text-accent" onClick={() => navigate({ section: "players", id: row.accountId })}>
                    {row.displayName ?? row.accountId}
                  </button>
                ),
              },
              { title: "Роль", render: (row) => roleName(row.role) },
              { title: "Выдана", render: (row) => formatDateTime(row.grantedAt) },
              { title: "Кем", render: (row) => (row.grantedBy === null ? "система" : <code className="text-xs text-text-muted">{row.grantedBy.slice(0, 8)}</code>) },
              {
                title: "",
                render: (row) =>
                  confirmRevoke === keyOf(row) ? (
                    <span className="flex gap-1">
                      <Button tone="danger" disabled={pending} onClick={() => void revoke(row)}>
                        Да, снять
                      </Button>
                      <Button onClick={() => setConfirmRevoke(null)}>Отмена</Button>
                    </span>
                  ) : (
                    <Button onClick={() => setConfirmRevoke(keyOf(row))}>Снять</Button>
                  ),
              },
            ]}
          />
        ) : null}
      </Panel>
    </div>
  );
}
