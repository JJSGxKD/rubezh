import { useState, type ReactNode } from "react";
import { approveChange, fetchChangeRequests, rejectChange, withdrawChange, type ChangeOverview, type ChangeRequest, type ChangeTarget } from "../../../api/change-requests";
import { api } from "../../../services";
import { useSession } from "../../../state/use-session";
import { ConfirmDialog } from "../../../ui/confirm-dialog";
import { Badge, Button, ErrorNotice, Loading, Notice, Panel } from "../../../ui/kit";
import { toast, toastError } from "../../../ui/toast";
import { useApi } from "../../../ui/use-api";
import { ChangeRequestList } from "./ChangeRequestList";
import { ProposeDialog } from "./ProposeDialog";
import { RewardProposeDialog, RewardSettings } from "./RewardSettings";
import { KIND_REWARD, KIND_SKU, describeChange, skuValuesOf } from "./prices-rules";

/**
 * Вкладка «Цены и награды» раздела «Баланс» (docs/19-content-admin.md §6,
 * tasks/T-0309, T-0310): товары с ценой сейчас и «Предложить цену», награды
 * с «Предложить», ниже — заявки на то и другое. Цену и награду меняет только
 * заявка, которую подтвердил другой участник; у автора «Подтвердить» нет.
 * Вкладка не зависит от черновика баланса: цены и награды живут отдельно от
 * чисел забега.
 */
export function PricesTab(): ReactNode {
  const { state, reload } = useApi(() => fetchChangeRequests(api), []);
  const meId = useSession((session) => (session.view.status === "ready" ? session.view.identity.account.accountId : ""));
  const canEdit = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("sku.price.edit"));
  const [proposing, setProposing] = useState<ChangeTarget | null>(null);
  const [proposingReward, setProposingReward] = useState<ChangeTarget | null>(null);
  const [approving, setApproving] = useState<ChangeRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const overview: ChangeOverview = state.data;
  const targets = overview.targets[KIND_SKU] ?? [];
  const rewardTargets = overview.targets[KIND_REWARD] ?? [];
  const titleOf = (kind: string, target: string): string => ((overview.targets[kind] ?? []).find((candidate) => candidate.target === target)?.title ?? target);
  const waitingFor = (kind: string, target: string): ChangeRequest | null => overview.requests.find((request) => request.kind === kind && request.target === target && request.status === "pending") ?? null;

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
        Цену и награду меняет заявка: один участник предлагает «было → стало» с причиной, другой с тем же правом подтверждает. Заявка живёт {overview.ttlHours} ч, свою подтвердить нельзя.
        {canEdit ? "" : " Только чтение: подавать и решать заявки может тот, у кого есть право «sku.price.edit»."}
      </Notice>

      <Panel title="Товары">
        {targets.length === 0 ? (
          <p className="text-sm text-text-muted">Товаров в каталоге нет</p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {targets.map((target) => (
              <ProductCard key={target.target} target={target} waiting={waitingFor(KIND_SKU, target.target) !== null} canEdit={canEdit} onPropose={() => setProposing(target)} />
            ))}
          </ul>
        )}
      </Panel>

      <RewardSettings targets={rewardTargets} canEdit={canEdit} waitingFor={(target) => waitingFor(KIND_REWARD, target)} onPropose={setProposingReward} />

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
        waiting={proposing === null ? null : waitingFor(KIND_SKU, proposing.target)}
        onClose={() => setProposing(null)}
        onSent={() => {
          setProposing(null);
          toast.success("Заявка отправлена — цена изменится, когда её подтвердит другой участник");
          reload();
        }}
      />

      <RewardProposeDialog
        target={proposingReward}
        waiting={proposingReward === null ? null : waitingFor(KIND_REWARD, proposingReward.target)}
        onClose={() => setProposingReward(null)}
        onSent={(request) => {
          setProposingReward(null);
          // Предупреждение о потолке кошелька — совет: заявка заведена, но решающий должен его увидеть.
          toast.success("Заявка отправлена — число изменится, когда её подтвердит другой участник");
          for (const warning of request.warnings ?? []) toast.warning(warning);
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
                ...(approving.warnings === undefined || approving.warnings.length === 0 ? [] : [{ label: "Внимание", value: approving.warnings.join("; ") }]),
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
          toast.success(approving.kind === KIND_REWARD ? "Заявка подтверждена — новое число действует со следующей награды" : "Заявка подтверждена — новая цена уже действует");
          return { ok: true };
        }}
      />
    </div>
  );
}

/**
 * Товар карточкой: цена в звёздах крупно, остальные поля мелко. Карточки, а не
 * таблица: на 320 px и рядом с боковым меню шесть колонок не помещаются, а
 * кнопка «Предложить цену» обрезалась.
 */
function ProductCard({ target, waiting, canEdit, onPropose }: { target: ChangeTarget; waiting: boolean; canEdit: boolean; onPropose: () => void }): ReactNode {
  const current = skuValuesOf(target.current);
  const inCode = skuValuesOf(target.inCode);
  const changed = current !== null && inCode !== null && target.overridden && inCode.stars !== current.stars;
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-sm border border-border bg-surface-sunken p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="break-words font-medium">{target.title}</div>
          <div className="text-xs text-text-muted">{target.target}</div>
        </div>
        {waiting ? <Badge tone="warning">ждёт заявка</Badge> : null}
      </div>
      {current === null ? (
        <p className="text-sm text-text-muted">Значения не разобрались</p>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
            <span className="text-xl font-semibold">{current.stars} ⭐</span>
            {changed ? <span className="text-xs text-text-muted">в коде {inCode.stars}</span> : null}
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-text-muted">Цена, ₽</dt>
            <dd className="text-right tabular-nums">{current.baseRub}</dd>
            <dt className="text-text-muted">Самоцветов</dt>
            <dd className="text-right tabular-nums">{current.contents.gems}</dd>
            <dt className="text-text-muted">Значок</dt>
            <dd className="text-right">{current.badge === "hit" ? "«Хит»" : "—"}</dd>
            <dt className="text-text-muted">Порядок</dt>
            <dd className="text-right tabular-nums">{current.sort}</dd>
          </dl>
        </>
      )}
      {canEdit ? (
        <div>
          <Button onClick={onPropose}>Предложить цену</Button>
        </div>
      ) : null}
    </li>
  );
}
