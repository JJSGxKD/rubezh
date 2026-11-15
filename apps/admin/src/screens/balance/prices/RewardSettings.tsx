import { useState, type ReactNode } from "react";
import { proposeChange, type ChangeRequest, type ChangeTarget } from "../../../api/change-requests";
import { api } from "../../../services";
import { Dialog } from "../../../ui/dialog";
import { Badge, Button, Field, Input, Notice, Panel, TextArea } from "../../../ui/kit";
import { KIND_REWARD, describeChange, emptyRewardDraft, rewardAfter, rewardProblem, rewardValueOf, type RewardDraft } from "./prices-rules";

const REASON_MAX = 200;

/**
 * Блок «Награды» вкладки «Цены и награды» (docs/19-content-admin.md §6,
 * tasks/T-0310): числа наград за забег, за уровень и награда дня с текущим
 * значением и «Предложить». Число меняет только заявка, которую подтвердил
 * другой участник; действует оно со следующей награды, начисленное не
 * пересчитывается. Карточки, а не таблица: лестница — длинная строка, и на
 * 320 px колонки не помещаются.
 */
export function RewardSettings({
  targets,
  canEdit,
  waitingFor,
  onPropose,
}: {
  targets: readonly ChangeTarget[];
  canEdit: boolean;
  /** заявка на цель, которая ждёт решения */
  waitingFor: (target: string) => ChangeRequest | null;
  onPropose: (target: ChangeTarget) => void;
}): ReactNode {
  return (
    <Panel title="Награды" help="Монеты и опыт за забег, награды за уровень и награда дня. Меняются заявкой, как цены; действуют со следующей награды, начисленное не пересчитывается.">
      {targets.length === 0 ? (
        <p className="text-sm text-text-muted">Наград в каталоге настроек нет</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {targets.map((target) => (
            <RewardCard key={target.target} target={target} waiting={waitingFor(target.target) !== null} canEdit={canEdit} onPropose={() => onPropose(target)} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RewardCard({ target, waiting, canEdit, onPropose }: { target: ChangeTarget; waiting: boolean; canEdit: boolean; onPropose: () => void }): ReactNode {
  const current = rewardValueOf(target.current);
  const inCode = rewardValueOf(target.inCode);
  const isNumber = typeof current === "number";
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-sm border border-border bg-surface-sunken p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="break-words font-medium">{target.title}</div>
          <div className="break-all text-xs text-text-muted">{target.target}</div>
        </div>
        {waiting ? <Badge tone="warning">ждёт заявка</Badge> : null}
      </div>
      {current === null ? (
        <p className="text-sm text-text-muted">Значение не разобралось</p>
      ) : (
        <p className={`min-w-0 break-words tabular-nums ${isNumber ? "text-xl font-semibold" : "text-sm font-medium"}`}>{isNumber ? current.toLocaleString("ru-RU") : current}</p>
      )}
      {target.overridden && inCode !== null ? <p className="break-words text-xs text-text-muted">по умолчанию {typeof inCode === "number" ? inCode.toLocaleString("ru-RU") : inCode}</p> : null}
      {target.hint === undefined ? null : <p className="break-words text-xs text-text-muted">{target.hint}</p>}
      {canEdit ? (
        <div>
          <Button onClick={onPropose}>Предложить</Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Окно «Предложить» для награды: одно значение, причина и «было → стало».
 * Формат лестниц и пределы чисел проверяет сервер и отвечает словами — окно
 * показывает ответ; предупреждение о потолке кошелька приходит с заявкой.
 */
export function RewardProposeDialog({
  target,
  waiting,
  onClose,
  onSent,
}: {
  /** награда, по которой подают заявку; `null` — окно закрыто */
  target: ChangeTarget | null;
  /** заявка на эту награду, которая ждёт решения: новая её заменит */
  waiting: ChangeRequest | null;
  onClose: () => void;
  onSent: (request: ChangeRequest) => void;
}): ReactNode {
  return target === null ? null : <Form key={target.target} target={target} waiting={waiting} onClose={onClose} onSent={onSent} />;
}

function Form({ target, waiting, onClose, onSent }: { target: ChangeTarget; waiting: ChangeRequest | null; onClose: () => void; onSent: (request: ChangeRequest) => void }): ReactNode {
  const [draft, setDraft] = useState<RewardDraft>(() => emptyRewardDraft(target));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = rewardValueOf(target.current);
  const numeric = typeof current === "number";

  const problem = rewardProblem(draft, target);
  const after = rewardAfter(draft, target);
  const lines = problem === null ? describeChange(KIND_REWARD, { value: current }, after) : [];

  const send = async (): Promise<void> => {
    if (problem !== null) return;
    setPending(true);
    setError(null);
    const result = await proposeChange(api, { kind: KIND_REWARD, target: target.target, after, reason: draft.reason });
    setPending(false);
    if (!result.ok) return setError(result.error.message);
    onSent(result.data);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={`Предложить — ${target.title}`}
      description="Заявку подтверждает другой участник с правом на цены. Пока он не подтвердил, число не меняется; после — действует со следующей награды."
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Отмена
          </Button>
          <Button tone="primary" disabled={problem !== null || pending} blockedBy={pending ? null : problem} onClick={() => void send()}>
            {pending ? "Отправляем…" : "Отправить заявку"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {waiting === null ? null : <Notice tone="warning">На эту награду уже есть заявка: {describeChange(waiting.kind, waiting.before, waiting.after).join("; ")}. Новая заменит её, и подтвердить старую будет нельзя.</Notice>}
        {target.hint === undefined ? null : <p className="break-words text-sm text-text-muted">{target.hint}</p>}
        <Field label="Новое значение" hint={current === null ? undefined : `сейчас ${String(current)}`}>
          <Input inputMode={numeric ? "numeric" : "text"} value={draft.value} onChange={(event) => setDraft((previous) => ({ ...previous, value: event.target.value }))} className={numeric ? "w-40" : "w-full"} autoFocus />
        </Field>
        <Field label={`Причина — ${String(draft.reason.trim().length)} из ${String(REASON_MAX)}`} hint="По ней второй участник решит, подтверждать ли.">
          <TextArea rows={3} maxLength={REASON_MAX + 20} value={draft.reason} onChange={(event) => setDraft((previous) => ({ ...previous, reason: event.target.value }))} />
        </Field>
        {lines.length === 0 ? null : <Notice tone="info">Заявка: {lines.join("; ")}.</Notice>}
        {error === null ? null : <Notice>{error}</Notice>}
      </form>
    </Dialog>
  );
}
