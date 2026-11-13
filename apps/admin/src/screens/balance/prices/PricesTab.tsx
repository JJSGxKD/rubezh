import { useState, type ReactNode } from "react";
import { approveChange, fetchChangeRequests, rejectChange, withdrawChange, type ChangeOverview, type ChangeRequest, type ChangeTarget } from "../../../api/change-requests";
import { api } from "../../../services";
import { useSession } from "../../../state/use-session";
import { ConfirmDialog } from "../../../ui/confirm-dialog";
import { Badge, Button, DataTable, ErrorNotice, Loading, Notice, Panel } from "../../../ui/kit";
import { toast, toastError } from "../../../ui/toast";
import { useApi } from "../../../ui/use-api";
import { ChangeRequestList } from "./ChangeRequestList";
import { ProposeDialog } from "./ProposeDialog";
import { describeChange, skuValuesOf } from "./prices-rules";

const KIND_SKU = "sku_price";

/**
 * Вкладка «Цены и награды» раздела «Баланс» (docs/19-content-admin.md §6,
 * tasks/T-0309): товары с ценой сейчас и «Предложить цену», ниже — заявки.
 * Цену меняет только заявка, которую подтвердил другой участник; у автора
 * «Подтвердить» нет. Вкладка не зависит от черновика баланса: цены живут
 * отдельно от чисел забега.
 */
export function PricesTab(): ReactNode {
  const { state, reload } = useApi(() => fetchChangeRequests(api), []);
  const meId = useSession((session) => (session.view.status === "ready" ? session.view.identity.account.accountId : ""));
  const canEdit = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("sku.price.edit"));
  const [proposing, setProposing] = useState<ChangeTarget | null>(null);
  const [approving, setApproving] = useState<ChangeRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const overview: ChangeOverview = state.data;
  const targets = overview.targets[KIND_SKU] ?? [];
  const titleOf = (kind: string, target: string): string => (kind === KIND_SKU ? (targets.find((candidate) => candidate.target === target)?.title ?? target) : target);
  const waitingFor = (target: string): ChangeRequest | null => overview.requests.find((request) => request.kind === KIND_SKU && request.target === target && request.status === "pending") ?? null;

  const decide = async (request: ChangeRequest, act: (id: string) => ReturnType<typeof rejectChange>, done: string): Promise<void> => {
    setBusy(request.requestId);
    const result = await act(request.requestId);
    setBusy(null);
    if (!result.ok) {
      toastError(result.error);
      // Заявку могли закрыть, пока список был открыт: он перечитывается, чтобы кнопки не врали.
      reload();
      return;
    }
    toast.success(done);
    reload();
  };

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info">
        Цену меняет заявка: один участник предлагает «было → стало» с причиной, другой с тем же правом подтверждает. Заявка живёт {overview.ttlHours} ч, свою подтвердить нельзя.
        {canEdit ? "" : " Только чтение: подавать и решать заявки может тот, у кого есть право «sku.price.edit»."}
      </Notice>

      <Panel title="Товары">
        <DataTable
          rows={targets}
          rowKey={(target) => target.target}
          empty="Товаров в каталоге нет"
          columns={[
            {
              title: "Товар",
              primary: true,
              render: (target) => (
                <span className="flex flex-col">
                  <span>{target.title}</span>
                  <span className="text-xs text-text-muted">{target.target}</span>
                </span>
              ),
            },
            { title: "Цена, ⭐", align: "right", render: (target) => priceCell(target) },
            { title: "Цена, ₽", align: "right", render: (target) => skuValuesOf(target.current)?.baseRub ?? "—" },
            { title: "Самоцветов", align: "right", render: (target) => skuValuesOf(target.current)?.contents.gems ?? "—" },
            { title: "Значок", render: (target) => (skuValuesOf(target.current)?.badge === "hit" ? "«Хит»" : "—") },
            { title: "Порядок", align: "right", render: (target) => skuValuesOf(target.current)?.sort ?? "—" },
            {
              title: "",
              render: (target) => (
                <span className="flex flex-wrap items-center gap-2">
                  {waitingFor(target.target) === null ? null : <Badge tone="warning">ждёт заявка</Badge>}
                  {canEdit ? <Button onClick={() => setProposing(target)}>Предложить цену</Button> : null}
                </span>
              ),
            },
          ]}
        />
      </Panel>

      <Panel title="Заявки">
        <ChangeRequestList
          requests={overview.requests}
          meId={meId}
          now={new Date()}
          titleOf={titleOf}
          busy={busy}
          onApprove={setApproving}
          onReject={(request) => void decide(request, (id) => rejectChange(api, id), "Заявка отклонена")}
          onWithdraw={(request) => void decide(request, (id) => withdrawChange(api, id), "Заявка отозвана")}
        />
      </Panel>

      <ProposeDialog
        target={proposing}
        waiting={proposing === null ? null : waitingFor(proposing.target)}
        onClose={() => setProposing(null)}
        onSent={() => {
          setProposing(null);
          toast.success("Заявка отправлена — цена изменится, когда её подтвердит другой участник");
          reload();
        }}
      />

      <ConfirmDialog
        open={approving !== null}
        onOpenChange={(open) => {
          if (!open) setApproving(null);
        }}
        title="Подтвердить заявку"
        {...(approving === null ? {} : { subject: titleOf(approving.kind, approving.target) })}
        changes={
          approving === null
            ? []
            : [
                { label: "Было → стало", value: describeChange(approving.kind, approving.before, approving.after).join("; ") },
                { label: "Автор", value: approving.authorName ?? "—" },
                { label: "Причина", value: approving.reason },
              ]
        }
        problem={null}
        action="Подтвердить и применить"
        onConfirm={async () => {
          if (approving === null) return { ok: false, error: "Заявка не выбрана" };
          const result = await approveChange(api, approving.requestId);
          // Заявку могли решить или заменить, пока окно было открыто: список перечитывается в любом исходе.
          reload();
          if (!result.ok) return { ok: false, error: result.error.message };
          toast.success("Заявка подтверждена — новая цена уже действует");
          return { ok: true };
        }}
      />
    </div>
  );
}

/** Цена сейчас; изменённая командой — с пометкой и ценой в коде. */
function priceCell(target: ChangeTarget): ReactNode {
  const current = skuValuesOf(target.current);
  if (current === null) return "—";
  const inCode = skuValuesOf(target.inCode);
  if (!target.overridden || inCode === null || inCode.stars === current.stars) return current.stars;
  return (
    <span className="flex flex-col items-end">
      <span>{current.stars}</span>
      <span className="text-xs text-text-muted">в коде {inCode.stars}</span>
    </span>
  );
}
