import { useMemo, useState } from "react";
import { api } from "../../app";
import type { ApiError } from "../../api/client";
import { adjustWallet, banPlayer, resourceName, unbanPlayer, WALLET_RESOURCES, walletAdjustProblem, type PlayerCard } from "../../api/players";
import { formatDelta, formatNumber } from "../../format";
import { Button, Field, Input, Notice, Panel, Select } from "../../ui/kit";

/**
 * Действия с игроком — с подтверждением вторым нажатием: блокировка и
 * начисление видны игроку и попадают в аудит, случайный клик тут дорог.
 */

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

function OutcomeLine({ outcome }: { outcome: Outcome }) {
  if (outcome === null) return null;
  return outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>;
}

export function BanPanel({ card, onChanged }: { card: PlayerCard; onChanged: () => void }) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const banned = card.account.banned !== null;
  const accountId = card.account.accountId;

  const act = async () => {
    setPending(true);
    const result = banned ? await unbanPlayer(api, accountId) : await banPlayer(api, accountId, reason.trim());
    setPending(false);
    setConfirming(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: banned ? "Блокировка снята" : `Заблокирован, отозвано сессий: ${result.data.revokedSessions}` });
    setReason("");
    onChanged();
  };

  const reasonOk = banned || reason.trim().length >= 3;
  return (
    <Panel title={banned ? "Снять блокировку" : "Заблокировать"}>
      <div className="flex flex-col gap-3">
        {banned ? (
          <p className="text-sm text-text-muted">Причина блокировки: {card.account.banned?.reason ?? "не указана"}</p>
        ) : (
          <Field label="Причина" hint="От 3 до 256 символов. Игрок увидит её при входе; в аудит попадёт вместе с тем, кто блокировал.">
            <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={256} />
          </Field>
        )}
        <div className="flex gap-2">
          {confirming ? (
            <>
              <Button tone="danger" disabled={pending} onClick={() => void act()}>
                {banned ? "Да, снять" : "Да, заблокировать"}
              </Button>
              <Button onClick={() => setConfirming(false)}>Отмена</Button>
            </>
          ) : (
            <Button tone={banned ? "secondary" : "danger"} disabled={!reasonOk} onClick={() => setConfirming(true)}>
              {banned ? "Снять блокировку" : "Заблокировать"}
            </Button>
          )}
        </div>
        <OutcomeLine outcome={outcome} />
      </div>
    </Panel>
  );
}

/** Ключ операции: латиница, цифры и дефис — как ждёт сервер. */
function newKey(): string {
  return `panel-${crypto.randomUUID()}`;
}

export function WalletAdjustPanel({ card, onChanged }: { card: PlayerCard; onChanged: () => void }) {
  const [resource, setResource] = useState("coins");
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const [round, setRound] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const amount = Number(delta);
  const problem = delta === "" ? "Укажите изменение" : walletAdjustProblem(amount, note);
  // Ключ живёт, пока форма та же: повтор после обрыва сети не начислит
  // дважды, а другая сумма или ресурс — уже другая операция.
  const idempotencyKey = useMemo(() => newKey(), [resource, delta, note, round]);

  const act = async () => {
    setPending(true);
    const result = await adjustWallet(api, card.account.accountId, { resource, delta: amount, note: note.trim(), idempotencyKey });
    setPending(false);
    setConfirming(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    const text = result.data.duplicate
      ? `Эта операция уже проведена: баланс ${formatNumber(result.data.balance)}`
      : `${formatDelta(result.data.applied)} — ${resourceName(resource)}, баланс ${formatNumber(result.data.balance)}`;
    setOutcome({ tone: "success", text });
    setDelta("");
    setNote("");
    setRound((value) => value + 1);
    onChanged();
  };

  return (
    <Panel title="Ручная операция с кошельком">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[1fr_140px] gap-2">
          <Field label="Ресурс">
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
        <Field label="Причина" hint="Попадёт в журнал кошелька и в аудит.">
          <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} />
        </Field>
        <div className="flex items-center gap-2">
          {confirming && problem === null ? (
            <>
              <Button tone="danger" disabled={pending} onClick={() => void act()}>
                Да: {formatDelta(amount)} — {resourceName(resource)}
              </Button>
              <Button onClick={() => setConfirming(false)}>Отмена</Button>
            </>
          ) : (
            <Button tone="primary" disabled={problem !== null} onClick={() => setConfirming(true)}>
              Провести
            </Button>
          )}
          {problem !== null && delta !== "" ? <span className="text-xs text-text-muted">{problem}</span> : null}
        </div>
        <OutcomeLine outcome={outcome} />
      </div>
    </Panel>
  );
}
