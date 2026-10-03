import { useState, type FormEvent } from "react";
import {
  NETWORK_TASK_LIMITS,
  cadenceLabel,
  networkTaskProblem,
  networkTaskState,
  rewardLabel,
  saveNetworkTask,
  type NetworkTaskInput,
  type NetworkTaskRow,
} from "../../api/tasks";
import { hrefOf } from "../../routes";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, Field, Input, Notice, Panel } from "../../ui/kit";
import { toast } from "../../ui/toast";

/**
 * Задания рекламных сетей (docs/35-stage4-plan.md WP13, часть 6): строка на
 * сеть рядом с каталогом. Сами задания приходят от сети — здесь только
 * сколько их, как часто и что за них игрок получит. Чего не хватает, чтобы
 * игроки их увидели, строка говорит сама и ведёт туда, где это настраивают.
 */
export function NetworkTasksPanel({ rows, onSaved }: { rows: readonly NetworkTaskRow[]; onSaved: () => void }) {
  const [editing, setEditing] = useState<NetworkTaskRow | null>(null);
  if (rows.length === 0) return null;

  return (
    <Panel title="Задания рекламных сетей" help={HELP.tasks.networks}>
      <p className="mb-3 text-sm text-text-muted">
        Игрок видит их во вкладке «Партнёры» с пометкой «Реклама» и именем сети. Задание выбирает сеть, награду даёт сервер, когда сеть подтвердила
        выполнение. Сверх потолка и во время паузы строки сети у игрока просто нет.
      </p>
      <DataTable
        rows={[...rows]}
        rowKey={(row) => row.networkKey}
        onRowClick={(row) => setEditing(row)}
        columns={[
          {
            title: "Сеть",
            render: (row) => {
              const state = networkTaskState(row);
              return (
                <span className="flex flex-col items-start gap-1">
                  <span className="font-medium">{row.title}</span>
                  <Badge tone={state.tone}>{state.label}</Badge>
                </span>
              );
            },
          },
          { title: "Что нужно", render: (row) => <Readiness row={row} /> },
          { title: "Как часто", help: HELP.tasks.networkCadence, render: (row) => <span className="whitespace-nowrap">{cadenceLabel(row)}</span> },
          { title: "Награда", render: (row) => <span className="whitespace-nowrap">{rewardLabel(row)}</span> },
          {
            title: "",
            render: (row) => (
              <Button
                onClick={(event) => {
                  event.stopPropagation();
                  setEditing(row);
                }}
              >
                Изменить
              </Button>
            ),
          },
        ]}
      />
      {editing === null ? null : (
        <EditDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            toast.success(`Задания ${saved.title} сохранены`, { description: "Игроки увидят новые числа в течение полуминуты" });
            onSaved();
          }}
        />
      )}
    </Panel>
  );
}

/**
 * Чек-лист готовности: что уже есть и куда идти за остальным. Подтверждение
 * ключом ведёт в «Ключи интеграций»; проверка по API сети — без ключа, её
 * строка просто говорит, как сеть подтверждает.
 */
function Readiness({ row }: { row: NetworkTaskRow }) {
  const { block, blockTitle, confirm, confirmWith, confirmSecret } = row.ready;
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      <li className={block ? "text-success" : "text-warning"}>
        {block ? `✓ Включён: ${blockTitle}` : `✕ Не включён: ${blockTitle} — `}
        {block ? null : (
          <a className="text-accent hover:underline" href={hrefOf({ section: "ads", id: null })} onClick={(event) => event.stopPropagation()}>
            «Реклама» → {row.title} → место «Задания»
          </a>
        )}
      </li>
      {confirmWith === null ? (
        <li className="text-warning">✕ Сеть пока не умеет подтверждать задания — награду выдать нечем</li>
      ) : (
        <li className={confirm ? "text-success" : "text-warning"}>
          {confirm ? `✓ ${confirmWith}` : `✕ ${confirmWith}: не создан — `}
          {confirm || !confirmSecret ? null : (
            <a className="text-accent hover:underline" href={hrefOf({ section: "secrets", id: null })} onClick={(event) => event.stopPropagation()}>
              «Ключи интеграций»
            </a>
          )}
        </li>
      )}
    </ul>
  );
}

function EditDialog({ row, onClose, onSaved }: { row: NetworkTaskRow; onClose: () => void; onSaved: (saved: NetworkTaskRow) => void }) {
  const [input, setInput] = useState<NetworkTaskInput>({
    networkKey: row.networkKey,
    active: row.active,
    dailyCap: row.dailyCap,
    pauseMin: row.pauseMin,
    coins: row.coins,
    gems: row.gems,
    shards: row.shards,
  });
  const [saving, setSaving] = useState(false);
  const problem = networkTaskProblem(input);

  const number = (field: "dailyCap" | "pauseMin" | "coins" | "gems" | "shards", range?: { min: number; max: number }) => ({
    value: String(input[field]),
    onChange: (event: { target: { value: string } }) => setInput({ ...input, [field]: event.target.value === "" ? 0 : Number(event.target.value) }),
    type: "number",
    min: range?.min ?? 0,
    max: range?.max,
    step: 1,
    className: "w-24",
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null || saving) return;
    setSaving(true);
    const result = await saveNetworkTask(api, input);
    setSaving(false);
    if (!result.ok) return void toast.error(result.error.message);
    onSaved(result.data);
  };

  const { dailyCap, pauseMin } = NETWORK_TASK_LIMITS;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Задания ${row.title}`}
      description="Новые числа заработают у игроков в течение полуминуты — и для заданий, которые сеть подтвердит после этого."
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button tone="primary" type="submit" form="network-task-form" disabled={problem !== null || saving}>
            {saving ? "Сохраняю…" : "Сохранить"}
          </Button>
        </>
      }
    >
      <form id="network-task-form" className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={input.active} onChange={(event) => setInput({ ...input, active: event.target.checked })} />
          Показывать задания {row.title} игрокам
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Заданий в сутки" hint={`${String(dailyCap.min)}–${String(dailyCap.max)}, сутки — московские`}>
            <Input {...number("dailyCap", dailyCap)} />
          </Field>
          <Field label="Пауза, мин" hint={`после выполненного, ${String(pauseMin.min)}–${String(pauseMin.max)}`}>
            <Input {...number("pauseMin", pauseMin)} />
          </Field>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Монеты">
            <Input {...number("coins")} />
          </Field>
          <Field label="Самоцветы">
            <Input {...number("gems")} />
          </Field>
          <Field label="Осколки">
            <Input {...number("shards")} />
          </Field>
        </div>
        {problem === null ? (
          <p className="text-xs text-text-muted">
            Игрок получит не больше {String(input.dailyCap)} заданий {row.title} за сутки и не чаще раза в {String(input.pauseMin)} мин — до{" "}
            {rewardLabel({ coins: input.coins * input.dailyCap, gems: input.gems * input.dailyCap, shards: input.shards * input.dailyCap }) || "0"} в сутки.
          </p>
        ) : (
          <Notice tone="warning">{problem}</Notice>
        )}
      </form>
    </Dialog>
  );
}
