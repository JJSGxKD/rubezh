import { useMemo, useState } from "react";
import { api } from "../../services";
import { adjustWallet, messagePlayer, resourceName, TEAM_MESSAGE_MAX, WALLET_RESOURCES, walletAdjustProblem, type PlayerCard } from "../../api/players";
import { formatDelta, formatNumber } from "../../format";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { HELP } from "../../ui/help";
import { Field, Input, Select } from "../../ui/kit";
import { toast } from "../../ui/toast";

/**
 * Действия с игроком — окнами подтверждения (`ConfirmDialog`, docs/29-admin-panel.md
 * §4): начисление и сообщение видны игроку и попадают в аудит, случайный клик
 * тут дорог. Окна открывает шапка карточки. Блокировка — ограничение «всё»
 * в `RestrictDialog`.
 */

/** Ключ операции: латиница, цифры и дефис — как ждёт сервер. */
function newKey(): string {
  return `panel-${crypto.randomUUID()}`;
}

/** Ручная операция с кошельком: ресурс и сумма, «было → станет», причина. */
export function WalletAdjustDialog({ card, open, onOpenChange, onChanged }: { card: PlayerCard; open: boolean; onOpenChange: (open: boolean) => void; onChanged: () => void }) {
  const [resource, setResource] = useState("coins");
  const [delta, setDelta] = useState("");
  const [round, setRound] = useState(0);

  const amount = Number(delta);
  // Причина проверяется самим окном: здесь — только ресурс и сумма.
  const problem = delta === "" ? "Укажите изменение" : walletAdjustProblem(amount, "···");
  // Ключ живёт, пока форма та же: повтор после обрыва сети не начислит
  // дважды, а другая сумма или ресурс — уже другая операция.
  const idempotencyKey = useMemo(() => newKey(), [resource, delta, round]);

  const before = card.wallet.balances[resource] ?? 0;
  const ready = problem === null;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Ручная операция с кошельком"
      subject={card.account.displayName}
      problem={delta === "" ? null : problem}
      changes={
        ready
          ? [
              { label: "Ресурс", value: resourceName(resource) },
              { label: "Изменение", value: formatDelta(amount) },
              { label: "Баланс", value: `${formatNumber(before)} → ${formatNumber(before + amount)}` },
            ]
          : []
      }
      reason={{ min: 3, max: 200, hint: "Попадёт в журнал кошелька и в аудит." }}
      action={ready ? `Провести ${formatDelta(amount)} — ${resourceName(resource)}` : "Провести"}
      tone={ready && amount < 0 ? "danger" : "primary"}
      onConfirm={async (note) => {
        if (!ready) return { ok: false, error: problem ?? "Укажите изменение" };
        const result = await adjustWallet(api, card.account.accountId, { resource, delta: amount, note, idempotencyKey });
        if (!result.ok) return { ok: false, error: result.error.message };
        toast.success(
          result.data.duplicate
            ? `Эта операция уже проведена: баланс ${formatNumber(result.data.balance)}`
            : `${formatDelta(result.data.applied)} — ${resourceName(resource)}, баланс ${formatNumber(result.data.balance)}`,
        );
        setDelta("");
        setRound((value) => value + 1);
        onChanged();
        return { ok: true };
      }}
    >
      <div className="grid grid-cols-[1fr_140px] gap-2">
        <Field label="Ресурс" help={HELP.players.walletOp}>
          <Select value={resource} onChange={(event) => setResource(event.target.value)}>
            {WALLET_RESOURCES.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Изменение">
          <Input value={delta} onChange={(event) => setDelta(event.target.value.trim())} inputMode="numeric" placeholder="50 или -20" />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

/**
 * Сообщение команды в ленту уведомлений игрока (docs/35-stage4-plan.md Р51):
 * ответ на жалобу, объяснение блокировки или поправки. Игрок увидит его в
 * игре подписью «Команда»; текст уходит в журнал действий.
 */
export function MessageDialog({ card, open, onOpenChange }: { card: PlayerCard; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [round, setRound] = useState(0);
  // Ключ живёт, пока сообщение не ушло: повтор после обрыва сети второй
  // строки в ленте не заведёт.
  const idempotencyKey = useMemo(() => newKey(), [round]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Сообщение игроку"
      subject={card.account.displayName}
      reason={{
        min: 3,
        max: TEAM_MESSAGE_MAX,
        label: "Текст",
        hint: `До ${String(TEAM_MESSAGE_MAX)} символов, простым текстом. Игрок увидит его в ленте уведомлений; в журнал действий попадёт вместе с тем, кто отправил.`,
      }}
      action="Отправить"
      onConfirm={async (text) => {
        const result = await messagePlayer(api, card.account.accountId, { text, idempotencyKey });
        if (!result.ok) return { ok: false, error: result.error.message };
        toast.success(result.data.duplicate ? "Это сообщение уже отправлено" : "Отправлено в ленту игрока");
        setRound((value) => value + 1);
        return { ok: true };
      }}
    />
  );
}
