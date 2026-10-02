import { useState, type FormEvent } from "react";
import { api } from "../../services";
import { checkSecret, fetchSecrets, groupSecrets, resetSecret, saveSecret, secretProblem, secretState, type SecretCheck, type SecretRow } from "../../api/secrets";
import { formatDateTime, formatTime } from "../../format";
import { useSession } from "../../state/use-session";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, ErrorNotice, Field, Help, Input, Loading, Notice, Panel } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";

type CheckState = { pending: true } | { pending: false; result: SecretCheck; at: number };

/**
 * Ключи интеграций (docs/35-stage4-plan.md Р84, WP46): токены внешних
 * сервисов, которые меняются без релиза и без доступа к серверу.
 *
 * Значение не показывается никогда — ни в списке, ни после сохранения: панель
 * знает только последние знаки, чтобы их сверить с кабинетом сервиса. Поле
 * ввода живёт, пока открыт диалог, и очищается при закрытии.
 */
export function SecretsScreen() {
  const { state, reload } = useApi(() => fetchSecrets(api), []);
  const canEdit = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("secrets.edit"));
  const [editing, setEditing] = useState<SecretRow | null>(null);
  const [resetting, setResetting] = useState<SecretRow | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});

  const check = async (row: SecretRow) => {
    setChecks((current) => ({ ...current, [row.key]: { pending: true } }));
    const result = await checkSecret(api, row.key, null);
    const outcome: SecretCheck = result.ok ? result.data : { ok: false, message: result.error.message };
    setChecks((current) => ({ ...current, [row.key]: { pending: false, result: outcome, at: Date.now() } }));
  };

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const { enabled, secrets } = state.data;
  const editable = canEdit && enabled;

  return (
    <div className="flex flex-col gap-4">
      {enabled ? null : (
        <Notice tone="info">
          Хранилище ключей выключено: на сервере не задан ключ шифрования. Задайте <code className="font-mono">SECRETS_ENCRYPTION_KEY</code> в .env сервера —
          его даёт команда <code className="font-mono">openssl rand -base64 32</code> — и перезапустите API. Пока ключи сервисов берутся только из окружения.
        </Notice>
      )}
      {groupSecrets(secrets).map(({ service, rows }) => (
        <Panel key={service} title={service} help={HELP.secrets.service} actions={<Button onClick={reload}>Обновить</Button>}>
          <div className="flex flex-col divide-y divide-border">
            {rows.map((row) => (
              <SecretCard
                key={row.key}
                row={row}
                editable={editable}
                check={checks[row.key] ?? null}
                onCheck={() => void check(row)}
                onEdit={() => setEditing(row)}
                onReset={() => setResetting(row)}
              />
            ))}
          </div>
        </Panel>
      ))}
      {canEdit ? null : <p className="text-xs text-text-muted">Заменить ключ может только владелец. Вам видно, задан ли ключ и откуда он.</p>}
      {editing === null ? null : (
        <ReplaceDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setChecks((current) => {
              const next = { ...current };
              delete next[saved.key];
              return next;
            });
            toast.success(`«${saved.title}» сохранён`, { description: `Работает ключ ${saved.fingerprint ?? ""} — со следующего обращения к сервису, без перезапуска` });
            reload();
          }}
        />
      )}
      {resetting === null ? null : (
        <ResetDialog
          row={resetting}
          onClose={() => setResetting(null)}
          onDone={(saved) => {
            setResetting(null);
            toast.success(`«${saved.title}» сброшен`, { description: saved.source === "env" ? `Работает ключ из окружения ${saved.fingerprint ?? ""}` : "Ключа больше нет ни в панели, ни в окружении" });
            reload();
          }}
        />
      )}
    </div>
  );
}

function SecretCard({ row, editable, check, onCheck, onEdit, onReset }: { row: SecretRow; editable: boolean; check: CheckState | null; onCheck: () => void; onEdit: () => void; onReset: () => void }) {
  const look = secretState(row);
  // Нечитаемая строка тоже лежит в базе: сброс убирает её, и ключ задают заново.
  const inBase = row.source === "base" || row.unreadable;
  return (
    <article className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 max-w-2xl flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{row.title}</span>
          <Badge tone={look.tone}>{look.label}</Badge>
          {row.fingerprint === null ? null : (
            <span className="inline-flex items-center gap-1">
              <code className="font-mono text-xs text-text-muted">{row.fingerprint}</code>
              <Help text={HELP.secrets.fingerprint} />
            </span>
          )}
        </div>
        <p className="text-xs text-text-muted">{row.hint}</p>
        <p className="text-xs text-text-muted">
          {look.detail}
          {row.source === "base" && row.updatedAt !== null ? ` Задан в панели ${formatDateTime(row.updatedAt)}${row.updatedByName === null ? "" : ` · ${row.updatedByName}`}.` : ""}
        </p>
        {check === null || check.pending ? null : <CheckLine result={check.result} at={check.at} />}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {row.cabinetUrl === null ? null : (
          <a href={row.cabinetUrl} target="_blank" rel="noreferrer noopener" className="text-xs text-accent hover:underline">
            Кабинет ↗
          </a>
        )}
        {row.checkable && row.fingerprint !== null ? (
          <span className="inline-flex items-center gap-1">
            <Button onClick={onCheck} disabled={check?.pending === true}>
              {check?.pending === true ? "Проверяю…" : "Проверить"}
            </Button>
            <Help text={HELP.secrets.check} />
          </span>
        ) : null}
        {editable ? (
          <Button tone="primary" onClick={onEdit}>
            {row.source === "base" ? "Заменить" : "Задать в панели"}
          </Button>
        ) : null}
        {editable && inBase ? <Button onClick={onReset}>Сбросить</Button> : null}
      </div>
    </article>
  );
}

function CheckLine({ result, at }: { result: SecretCheck; at: number }) {
  return (
    <p role="status" className={`text-xs ${result.ok ? "text-success" : "text-danger"}`}>
      {result.ok ? "✓" : "✕"} {result.message} · {formatTime(at)}
    </p>
  );
}

/**
 * Замена ключа. Значение — только в состоянии диалога: закрыли — пропало.
 * «Проверить» спрашивает сервис ключом из поля до сохранения, но сохранить
 * можно и без проверки: сервис может лежать, а ключ — быть верным.
 */
function ReplaceDialog({ row, onClose, onSaved }: { row: SecretRow; onClose: () => void; onSaved: (saved: SecretRow) => void }) {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<CheckState | null>(null);
  const problem = secretProblem(row, value);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem !== null || saving) return;
    setSaving(true);
    const result = await saveSecret(api, row.key, value);
    setSaving(false);
    if (!result.ok) return void toast.error(result.error.message);
    onSaved(result.data);
  };

  const verify = async () => {
    setTouched(true);
    if (problem !== null) return;
    setCheck({ pending: true });
    const result = await checkSecret(api, row.key, value);
    setCheck({ pending: false, result: result.ok ? result.data : { ok: false, message: result.error.message }, at: Date.now() });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${row.source === "base" ? "Заменить" : "Задать"}: ${row.title}`}
      description={row.hint}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          {row.checkable ? (
            <Button onClick={() => void verify()} disabled={check?.pending === true}>
              {check?.pending === true ? "Проверяю…" : "Проверить"}
            </Button>
          ) : null}
          <Button tone="primary" type="submit" form="secret-form" disabled={saving}>
            {saving ? "Сохраняю…" : "Сохранить ключ"}
          </Button>
        </>
      }
    >
      <form id="secret-form" className="flex flex-col gap-3" onSubmit={(event) => void submit(event)} autoComplete="off">
        <Field label="Новый ключ" error={touched ? (problem ?? undefined) : undefined} hint={`Выглядит как «${row.example}». Пробелы по краям уберутся сами.`}>
          <div className="flex gap-2">
            <Input
              type={shown ? "text" : "password"}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setCheck(null);
              }}
              onBlur={() => setTouched(value !== "")}
              placeholder={row.example}
              spellCheck={false}
              autoComplete="off"
              autoFocus
              className="w-full font-mono"
            />
            <Button onClick={() => setShown((current) => !current)} aria-pressed={shown}>
              {shown ? "Скрыть" : "Показать"}
            </Button>
          </div>
        </Field>
        {check === null || check.pending ? null : <CheckLine result={check.result} at={check.at} />}
        {row.cabinetUrl === null ? null : (
          <p className="text-xs text-text-muted">
            Где взять:{" "}
            <a href={row.cabinetUrl} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
              кабинет сервиса ↗
            </a>
          </p>
        )}
        <p className="text-xs text-text-muted">
          Ключ заработает со следующего обращения к сервису — без перезапуска. Хранится зашифрованным, в журнал аудита попадут только последние знаки.
          {row.source === "base" && row.fingerprint !== null ? ` Сейчас работает ${row.fingerprint}.` : ""}
        </p>
      </form>
    </Dialog>
  );
}

function ResetDialog({ row, onClose, onDone }: { row: SecretRow; onClose: () => void; onDone: (saved: SecretRow) => void }) {
  const [pending, setPending] = useState(false);
  const reset = async () => {
    setPending(true);
    const result = await resetSecret(api, row.key);
    setPending(false);
    if (!result.ok) return void toast.error(result.error.message);
    onDone(result.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Сбросить: ${row.title}`}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button tone="danger" onClick={() => void reset()} disabled={pending}>
            {pending ? "Сбрасываю…" : "Сбросить к окружению"}
          </Button>
        </>
      }
    >
      <p className="text-sm">
        Ключ из панели будет удалён.{" "}
        {row.envSet ? "Со следующего обращения заработает ключ из .env сервера." : "В окружении сервера ключа нет — сервис останется без ключа."}
      </p>
    </Dialog>
  );
}
