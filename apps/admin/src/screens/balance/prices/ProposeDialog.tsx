import { useState, type ReactNode } from "react";
import { proposeChange, type ChangeRequest, type ChangeTarget } from "../../../api/change-requests";
import { api } from "../../../services";
import { Dialog } from "../../../ui/dialog";
import { Button, Field, FieldRow, Input, Notice, Select, TextArea } from "../../../ui/kit";
import { beforeOf, describeChange, emptyProposal, proposalAfter, proposalProblem, skuValuesOf, type ProposalDraft } from "./prices-rules";

const REASON_MAX = 200;

/**
 * Окно «Предложить цену» (docs/19-content-admin.md §6, tasks/T-0309): поля
 * товара с текущими значениями, причина и предпросмотр «было → стало». Цена не
 * меняется, пока заявку не подтвердит другой участник. Проверка формы — тем же
 * правилом, что на сервере (`prices-rules.ts`): опечатку видно до отправки, а
 * сервер, если не согласится, объяснит словами.
 */
export function ProposeDialog({
  target,
  waiting,
  onClose,
  onSent,
}: {
  /** товар, по которому подают заявку; `null` — окно закрыто */
  target: ChangeTarget | null;
  /** заявка на этот товар, которая ждёт решения: новая её заменит */
  waiting: ChangeRequest | null;
  onClose: () => void;
  onSent: (request: ChangeRequest) => void;
}): ReactNode {
  // Окно живёт, пока выбран товар: форма начинается заново при каждом выборе.
  return target === null ? null : <Form key={target.target} target={target} waiting={waiting} onClose={onClose} onSent={onSent} />;
}

function Form({ target, waiting, onClose, onSent }: { target: ChangeTarget; waiting: ChangeRequest | null; onClose: () => void; onSent: (request: ChangeRequest) => void }): ReactNode {
  const [draft, setDraft] = useState<ProposalDraft>(() => emptyProposal(target));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = skuValuesOf(target.current);
  const inCode = skuValuesOf(target.inCode);

  const set = (patch: Partial<ProposalDraft>): void => setDraft((previous) => ({ ...previous, ...patch }));
  const problem = proposalProblem(draft, target);
  const after = proposalAfter(draft, target);
  const lines = describeChange("sku_price", beforeOf(target, after), after);

  const send = async (): Promise<void> => {
    if (problem !== null) return;
    setPending(true);
    setError(null);
    const result = await proposeChange(api, { kind: "sku_price", target: target.target, after, reason: draft.reason });
    setPending(false);
    if (!result.ok) return setError(result.error.message);
    onSent(result.data);
  };

  const was = (value: string | undefined, code: string | undefined): string | undefined => (value === undefined ? undefined : code !== undefined && code !== value ? `сейчас ${value}, в коде ${code}` : `сейчас ${value}`);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={`Предложить цену — ${target.title}`}
      description="Заявку подтверждает другой участник с правом на цены. Пока он не подтвердил, цена не меняется."
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
        {waiting === null ? null : <Notice tone="warning">На этот товар уже есть заявка: {describeChange(waiting.kind, waiting.before, waiting.after).join("; ")}. Новая заменит её, и подтвердить старую будет нельзя.</Notice>}
        <FieldRow>
          <Field label="Цена, ⭐" hint={was(current === null ? undefined : String(current.stars), inCode === null ? undefined : String(inCode.stars))}>
            <Input inputMode="numeric" value={draft.stars} onChange={(event) => set({ stars: event.target.value })} className="w-28" autoFocus />
          </Field>
          <Field label="Цена, ₽" hint={was(current?.baseRub, inCode?.baseRub)}>
            <Input inputMode="decimal" value={draft.baseRub} onChange={(event) => set({ baseRub: event.target.value })} className="w-28" />
          </Field>
          <Field label="Самоцветов в наборе" hint={was(current === null ? undefined : String(current.contents.gems), inCode === null ? undefined : String(inCode.contents.gems))}>
            <Input inputMode="numeric" value={draft.gems} onChange={(event) => set({ gems: event.target.value })} className="w-28" />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Значок">
            <Select value={draft.badge} onChange={(event) => set({ badge: event.target.value })}>
              <option value="">Без значка</option>
              <option value="hit">«Хит»</option>
            </Select>
          </Field>
          <Field label="Порядок на витрине" hint={was(current === null ? undefined : String(current.sort), inCode === null ? undefined : String(inCode.sort))}>
            <Input inputMode="numeric" value={draft.sort} onChange={(event) => set({ sort: event.target.value })} className="w-28" />
          </Field>
        </FieldRow>
        <Field label={`Причина — ${String(draft.reason.trim().length)} из ${String(REASON_MAX)}`} hint="По ней второй участник решит, подтверждать ли.">
          <TextArea rows={3} maxLength={REASON_MAX + 20} value={draft.reason} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
        {lines.length === 0 ? null : (
          <Notice tone="info">
            Заявка: {lines.join("; ")}.
          </Notice>
        )}
        {error === null ? null : <Notice>{error}</Notice>}
      </form>
    </Dialog>
  );
}
