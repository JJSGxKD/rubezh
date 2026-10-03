import { useMemo, useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import {
  adjustWallet,
  messagePlayer,
  resourceName,
  TEAM_MESSAGE_MAX,
  teamMessageProblem,
  WALLET_RESOURCES,
  walletAdjustProblem,
  type PlayerCard,
} from "../../api/players";
import { formatDelta, formatNumber } from "../../format";
import { Button, Field, Input, Notice, Panel, Select, TextArea } from "../../ui/kit";
import { HELP } from "../../ui/help";

/**
 * Действия с игроком — с подтверждением вторым нажатием: начисление и
 * сообщение видны игроку и попадают в аудит, случайный клик тут дорог.
 * Блокировка — ограничение «всё» в `RestrictionsPanel`.
 */

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

function OutcomeLine({ outcome }: { outcome: Outcome }) {
  if (outcome === null) return null;
  return outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>;
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
    <Panel title="Ручная операция с кошельком" help={HELP.players.walletOp}>
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

/**
 * Сообщение команды в ленту уведомлений игрока (docs/35-stage4-plan.md Р51):
 * ответ на жалобу, объяснение блокировки или поправки. Игрок увидит его в
 * игре подписью «Команда»; текст уходит в журнал действий.
 */
export function MessagePanel({ card }: { card: PlayerCard }) {
  const [text, setText] = useState("");
  const [round, setRound] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const problem = teamMessageProblem(text);
  // Ключ живёт, пока текст тот же: повтор после обрыва сети второй строки в
  // ленте не заведёт, а исправленный текст — уже другое сообщение.
  const idempotencyKey = useMemo(() => newKey(), [text, round]);

  const act = async () => {
    setPending(true);
    const result = await messagePlayer(api, card.account.accountId, { text: text.trim(), idempotencyKey });
    setPending(false);
    setConfirming(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: result.data.duplicate ? "Это сообщение уже отправлено" : "Отправлено в ленту игрока" });
    setText("");
    setRound((value) => value + 1);
  };

  return (
    <Panel title="Сообщение игроку">
      <div className="flex flex-col gap-3">
        <Field label="Текст" hint={`До ${String(TEAM_MESSAGE_MAX)} символов, простым текстом. Игрок увидит его в ленте уведомлений; в журнал действий попадёт вместе с тем, кто отправил.`}>
          <TextArea value={text} onChange={(event) => setText(event.target.value)} maxLength={TEAM_MESSAGE_MAX} rows={4} />
        </Field>
        <div className="flex items-center gap-2">
          {confirming && problem === null ? (
            <>
              <Button tone="primary" disabled={pending} onClick={() => void act()}>
                Да, отправить
              </Button>
              <Button onClick={() => setConfirming(false)}>Отмена</Button>
            </>
          ) : (
            <Button tone="primary" disabled={problem !== null} onClick={() => setConfirming(true)}>
              Отправить
            </Button>
          )}
          <span className="text-xs text-text-muted">
            {text.trim().length} / {TEAM_MESSAGE_MAX}
          </span>
        </div>
        <OutcomeLine outcome={outcome} />
      </div>
    </Panel>
  );
}
