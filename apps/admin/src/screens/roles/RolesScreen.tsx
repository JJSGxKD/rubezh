import { useEffect, useState } from "react";
import { api } from "../../services";
import {
  fetchAssignments,
  fetchCandidate,
  grantRole,
  revokeRole,
  roleName,
  rolePurpose,
  roleTargetOf,
  sectionsOfRole,
  teamOf,
  ROLE_NAMES,
  type Assignment,
  type Assignments,
  type RoleCandidate,
  type TeamMember,
} from "../../api/roles";
import { formatDateTime } from "../../format";
import { ChoiceCards } from "../../ui/choice";
import { Dialog } from "../../ui/dialog";
import { Badge, Button, DataTable, ErrorNotice, Field, Input, Loading, Panel } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { navigate } from "../../ui/router";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";

/**
 * Роли команды (docs/29-admin-panel.md §3.2): человек — строкой со всеми
 * своими ролями. Выдача — диалогом: сначала видно, кто это, потом — что
 * даст каждая роль; снятие — с подтверждением, где сказано, закроется ли
 * у человека доступ. Выдача и снятие — в аудит на сервере.
 */
export function RolesScreen() {
  const { state, reload } = useApi(() => fetchAssignments(api), []);
  const [granting, setGranting] = useState<{ accountId: string } | "new" | null>(null);
  const [revoking, setRevoking] = useState<{ member: TeamMember; assignment: Assignment } | null>(null);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const team = teamOf(state.data.assignments);

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Команда"
        help={HELP.roles.roles}
        actions={
          <Button tone="primary" onClick={() => setGranting("new")}>
            Выдать роль
          </Button>
        }
      >
        <DataTable
          rows={team}
          rowKey={(member) => member.accountId}
          empty="Ролей в базе нет — владелец пока только из ADMIN_TELEGRAM_IDS. Выдайте роли кнопкой «Выдать роль»."
          columns={[
            {
              title: "Человек",
              render: (member) => (
                <button type="button" className="text-left hover:text-accent" title="Открыть карточку" onClick={() => navigate({ section: "players", id: member.accountId })}>
                  {member.displayName ?? <code className="text-xs">{member.accountId.slice(0, 8)}</code>}
                </button>
              ),
            },
            {
              title: "Роли",
              render: (member) => (
                <span className="flex flex-wrap gap-1.5">
                  {member.assignments.map((assignment) => (
                    <RoleChip key={assignment.role} assignment={assignment} onRevoke={() => setRevoking({ member, assignment })} />
                  ))}
                </span>
              ),
            },
            { title: "В команде с", render: (member) => <span className="whitespace-nowrap">{formatDateTime(member.since)}</span> },
            {
              title: "",
              align: "right",
              render: (member) => <Button onClick={() => setGranting({ accountId: member.accountId })}>Ещё роль</Button>,
            },
          ]}
        />
      </Panel>

      {granting === null ? null : (
        <GrantDialog
          catalog={state.data.roles}
          accountId={granting === "new" ? null : granting.accountId}
          onClose={() => setGranting(null)}
          onGranted={reload}
        />
      )}
      {revoking === null ? null : <RevokeDialog {...revoking} onClose={() => setRevoking(null)} onRevoked={reload} />}
    </div>
  );
}

function RoleChip({ assignment, onRevoke }: { assignment: Assignment; onRevoke: () => void }) {
  const by = assignment.grantedBy === null ? "система" : (assignment.grantedByName ?? assignment.grantedBy.slice(0, 8));
  return (
    <span title={`Выдана ${formatDateTime(assignment.grantedAt)}, кем: ${by}`} className="inline-flex items-center gap-1 rounded-pill bg-accent/15 py-0.5 pr-1 pl-2.5 text-xs text-accent">
      {roleName(assignment.role)}
      <button type="button" onClick={onRevoke} aria-label={`Снять роль «${roleName(assignment.role)}»`} className="rounded-pill px-1 leading-none hover:bg-accent/25">
        ×
      </button>
    </span>
  );
}

type Lookup = { status: "idle" } | { status: "invalid" } | { status: "loading" } | { status: "found"; candidate: RoleCandidate } | { status: "missing" } | { status: "error"; message: string };

/** Пауза после ввода перед поиском: не спрашивать сервер на каждую цифру. */
const LOOKUP_DELAY_MS = 350;

/**
 * Выдача роли: кому — с именем найденного аккаунта до нажатия, какую — с
 * тем, что она даёт и какие разделы откроет; роли, которые уже есть, видны,
 * но не выбираются.
 */
function GrantDialog({ catalog, accountId, onClose, onGranted }: { catalog: Assignments["roles"]; accountId: string | null; onClose: () => void; onGranted: () => void }) {
  const [input, setInput] = useState(accountId ?? "");
  const [lookup, setLookup] = useState<Lookup>({ status: "idle" });
  const [role, setRole] = useState<string>("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (input.trim() === "") return setLookup({ status: "idle" });
    const target = roleTargetOf(input);
    if (target === null) return setLookup({ status: "invalid" });
    setLookup({ status: "loading" });
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchCandidate(api, target).then((result) => {
        if (cancelled) return;
        if (!result.ok) setLookup({ status: "error", message: result.error.message });
        else setLookup(result.data.candidate === null ? { status: "missing" } : { status: "found", candidate: result.data.candidate });
      });
    }, LOOKUP_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [input]);

  const candidate = lookup.status === "found" ? lookup.candidate : null;
  const has = (id: string) => candidate?.roles.includes(id) ?? false;
  const ready = candidate !== null && role !== "" && !has(role);

  const submit = async () => {
    if (candidate === null || role === "") return;
    setPending(true);
    const result = await grantRole(api, { accountId: candidate.accountId }, role);
    setPending(false);
    if (!result.ok) return void toast.error(result.error.message);
    toast.success(`${candidate.displayName}: роль «${roleName(role)}» выдана`, { description: "Права действуют сразу, без повторного входа" });
    onGranted();
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Выдать роль"
      description="Роль даёт права в панели и инструменты команды в игре. Выдача — в журнал аудита."
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button tone="primary" disabled={!ready || pending} onClick={() => void submit()}>
            {pending ? "Выдаём…" : ready ? `Выдать «${roleName(role)}» — ${candidate.displayName}` : "Выдать"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Кому" hint="Telegram ID цифрами — он есть в карточке игрока — или id аккаунта">
          <Input value={input} onChange={(event) => setInput(event.target.value)} className="w-96" maxLength={64} placeholder="123456789" autoFocus={accountId === null} />
        </Field>
        <LookupLine lookup={lookup} />
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Какую роль</h3>
          <ChoiceCards
            label="Роль"
            value={role}
            onChange={setRole}
            choices={ROLE_NAMES.map(([id, name]) => ({
              value: id,
              title: name,
              aside: has(id) ? <Badge>уже есть</Badge> : id === "owner" ? <Badge tone="warning">всё</Badge> : undefined,
              disabled: has(id),
              description: (
                <span className="flex flex-col gap-1">
                  <span>{rolePurpose(id)}</span>
                  <span className="text-text-disabled">Разделы: {sectionsOfRole(catalog.find((entry) => entry.role === id)?.permissions ?? [])}</span>
                </span>
              ),
            }))}
          />
        </section>
      </div>
    </Dialog>
  );
}

function LookupLine({ lookup }: { lookup: Lookup }) {
  switch (lookup.status) {
    case "idle":
      return null;
    case "invalid":
      return <p className="text-sm text-warning">Нужен Telegram ID цифрами или id аккаунта — @юзернейм не подойдёт: его можно сменить.</p>;
    case "loading":
      return <p className="text-sm text-text-muted">Ищем…</p>;
    case "missing":
      return <p className="text-sm text-warning">Такого аккаунта нет. Пусть человек сначала откроет игру или бота — аккаунт заводится входом.</p>;
    case "error":
      return <p className="text-sm text-danger">{lookup.message}</p>;
    case "found":
      return (
        <p className="rounded-sm border border-success/40 bg-surface-sunken px-3 py-2 text-sm">
          <span className="font-medium">{lookup.candidate.displayName}</span>
          <span className="text-text-muted"> · Telegram {lookup.candidate.platformUserId}</span>
          <span className="text-text-muted"> · {lookup.candidate.roles.length === 0 ? "ролей пока нет" : `уже: ${lookup.candidate.roles.map(roleName).join(", ")}`}</span>
        </p>
      );
  }
}

/** Снятие роли: что будет с доступом человека — до нажатия, а не после. */
function RevokeDialog({ member, assignment, onClose, onRevoked }: { member: TeamMember; assignment: Assignment; onClose: () => void; onRevoked: () => void }) {
  const [pending, setPending] = useState(false);
  const name = member.displayName ?? member.accountId.slice(0, 8);
  const last = member.assignments.length === 1;

  const submit = async () => {
    setPending(true);
    const result = await revokeRole(api, { accountId: member.accountId }, assignment.role);
    setPending(false);
    if (!result.ok) return void toast.error(result.error.message);
    const sessions = result.data.sessionsRevoked > 0 ? ` Закрыто сессий панели: ${String(result.data.sessionsRevoked)}.` : "";
    toast.success(`${name}: роль «${roleName(assignment.role)}» снята.${sessions}`);
    onRevoked();
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Снять роль «${roleName(assignment.role)}» — ${name}?`}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button tone="danger" disabled={pending} onClick={() => void submit()}>
            {pending ? "Снимаем…" : "Снять роль"}
          </Button>
        </>
      }
    >
      <p className="text-sm">
        {last
          ? "Это последняя роль: доступ к панели пропадёт сразу — все открытые сессии панели этого человека закроются."
          : `Остальные роли останутся: ${member.assignments
              .filter((other) => other.role !== assignment.role)
              .map((other) => roleName(other.role))
              .join(", ")}. Права этой роли пропадут с первого же запроса.`}
      </p>
    </Dialog>
  );
}
