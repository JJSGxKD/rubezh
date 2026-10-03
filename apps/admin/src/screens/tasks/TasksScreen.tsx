import { useState, type FormEvent } from "react";
import type { ApiError } from "../../api/client";
import {
  CHANNEL_KIND,
  CHANNEL_PLATFORMS,
  CHANNEL_PLATFORM_TITLES,
  GROUP_TITLES,
  KIND_TITLES,
  PARTNER_KINDS,
  PARTNER_PLATFORMS,
  PARTNER_PLATFORM_TITLES,
  PERIOD_TITLES,
  REPEAT_TITLES,
  TASK_LIMIT_RANGE,
  TASK_PERIODS,
  TIME_KINDS,
  TITLE_MAX,
  completionsLabel,
  fetchTasks,
  groupByPeriod,
  partnerPlatforms,
  rewardLabel,
  saveTask,
  targetLabel,
  taskProblem,
  togglePlatform,
  withKind,
  withPlatform,
  type TaskParams,
  type TaskDef,
} from "../../api/tasks";
import { api } from "../../services";
import { Badge, Button, DataTable, ErrorNotice, Field, Input, Loading, Notice, Panel, Select } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { useApi } from "../../ui/use-api";
import { NetworkTasksPanel } from "./NetworkTasksPanel";

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

const EMPTY: TaskDef = { taskId: "", period: "daily", kind: "runs", params: null, target: 1, title: null, coins: 0, gems: 0, shards: 0, passPoints: 0, sort: 0, active: true, limit: null };

/**
 * Задания и достижения (docs/35-stage4-plan.md Р52, WP13): что игроку делать
 * и что он за это получит — без релиза. Правка видна игрокам в пределах
 * полуминуты. Срок и вид у заведённого задания не меняются: прогресс игроков
 * записан по ним, — нужно другое — заводится новое, а старое выключается.
 * Удаления нет по той же причине.
 *
 * Подписку на канал проверяет бот площадки, когда игрок нажимает «Проверить»:
 * бот должен быть администратором канала, иначе площадка подписчиков не
 * покажет, и игрок увидит «проверка недоступна», а в логе — ошибку настройки.
 *
 * Задания рекламных сетей — строкой на сеть внизу (`NetworkTasksPanel`).
 */
export function TasksScreen() {
  const { state, reload } = useApi(() => fetchTasks(api), []);
  const [input, setInput] = useState<TaskDef>(EMPTY);
  const [original, setOriginal] = useState<TaskDef | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const catalog = state.status === "ok" ? state.data.tasks : [];
  const kinds = state.status === "ok" ? state.data.kinds : Object.keys(KIND_TITLES);
  const problem = taskProblem(input, original === null, catalog);

  const reset = () => {
    setInput(EMPTY);
    setOriginal(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    setPending(true);
    const result = await saveTask(api, input);
    setPending(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: original === null ? `Задание ${result.data.taskId} заведено — игроки увидят его в течение полуминуты` : `Задание ${result.data.taskId} сохранено` });
    reset();
    reload();
  };

  const partner = PARTNER_KINDS.has(input.kind);
  const channel = input.kind === CHANNEL_KIND;
  const setParams = (patch: Partial<TaskParams>) => setInput({ ...input, params: { ...(input.params ?? { url: "" }), ...patch } });

  const number = (field: "target" | "coins" | "gems" | "shards" | "passPoints" | "sort") => ({
    value: String(input[field]),
    onChange: (event: { target: { value: string } }) => setInput({ ...input, [field]: event.target.value === "" ? 0 : Number(event.target.value) }),
    type: "number",
    min: 0,
    step: 1,
    className: "w-24",
  });

  return (
    <div className="flex flex-col gap-4">
      <Panel title={original === null ? "Новое задание" : `Задание ${original.taskId}`}>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="id" hint="латиница, навсегда">
              <Input value={input.taskId} disabled={original !== null} onChange={(event) => setInput({ ...input, taskId: event.target.value.trim() })} placeholder="daily_boss" maxLength={48} className="w-44" />
            </Field>
            {channel ? (
              <Field label="Повтор" help={HELP.tasks.repeat}>
                <Select value={input.period} disabled={original !== null} onChange={(event) => setInput({ ...input, period: TASK_PERIODS.find((period) => period === event.target.value) ?? "achievement" })}>
                  {(["achievement", "daily", "weekly"] as const).map((period) => (
                    <option key={period} value={period}>
                      {REPEAT_TITLES[period]}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Срок" help={HELP.tasks.period}>
                <Select value={input.period} disabled={original !== null || partner} onChange={(event) => setInput({ ...input, period: TASK_PERIODS.find((period) => period === event.target.value) ?? "daily" })}>
                  {TASK_PERIODS.map((period) => (
                    <option key={period} value={period}>
                      {PERIOD_TITLES[period]}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Вид цели" help={HELP.tasks.kind}>
              <Select value={input.kind} disabled={original !== null} onChange={(event) => setInput(withKind(input, event.target.value))}>
                {kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_TITLES[kind] ?? kind}
                  </option>
                ))}
              </Select>
            </Field>
            {partner ? null : (
              <Field label="Цель" hint={TIME_KINDS.has(input.kind) ? `в секундах: ${targetLabel(input)}` : undefined}>
                <Input {...number("target")} min={1} />
              </Field>
            )}
          </div>
          {partner ? (
            <div className="flex flex-wrap items-end gap-2">
              {channel ? (
                <Field label="Площадка" hint="игроки других площадок задания не увидят">
                  <Select
                    value={input.params?.platform ?? ""}
                    onChange={(event) => setInput({ ...input, params: withPlatform(input.params, CHANNEL_PLATFORMS.find((candidate) => candidate === event.target.value)) })}
                  >
                    {CHANNEL_PLATFORMS.map((platform) => (
                      <option key={platform} value={platform}>
                        {CHANNEL_PLATFORM_TITLES[platform]}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-xs text-text-muted">Где показывать</legend>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 py-1.5 text-sm">
                    {PARTNER_PLATFORMS.map((platform) => (
                      <label key={platform} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={partnerPlatforms(input.params).includes(platform)}
                          onChange={() => setInput({ ...input, params: togglePlatform(input.params, platform) })}
                        />
                        {PARTNER_PLATFORM_TITLES[platform]}
                      </label>
                    ))}
                  </div>
                  <span className="text-xs text-text-disabled">ничего не отмечено — на всех площадках</span>
                </fieldset>
              )}
              {channel ? (
                <Field label="Канал" hint="@имя или id — по нему спрашивает бот">
                  <Input value={input.params?.chat ?? ""} onChange={(event) => setParams({ chat: event.target.value })} placeholder="@rubezh_game" maxLength={64} className="w-44" />
                </Field>
              ) : null}
              <Field label="Лимит выполнений" help={HELP.tasks.completionLimit} hint="пусто — без лимита">
                <Input
                  value={input.limit === null ? "" : String(input.limit)}
                  onChange={(event) => setInput({ ...input, limit: event.target.value.trim() === "" ? null : Number(event.target.value) })}
                  type="number"
                  min={TASK_LIMIT_RANGE.min}
                  max={TASK_LIMIT_RANGE.max}
                  step={1}
                  placeholder="без лимита"
                  className="w-32"
                />
              </Field>
              <Field label="Ссылка" hint="её откроет игрок">
                <Input
                  value={input.params?.url ?? ""}
                  onChange={(event) => setParams({ url: event.target.value })}
                  placeholder={input.kind === "bot" ? "https://t.me/partner_bot?start=rubezh" : "https://t.me/rubezh_game"}
                  maxLength={256}
                  className="w-72"
                />
              </Field>
            </div>
          ) : null}
          {channel ? (
            <Notice tone="info">
              Бот проверяет подписку, когда игрок нажимает «Проверить», — сделайте его администратором канала: без этого площадка подписчиков не покажет.
              {input.period === "achievement" ? null : ` Награда — ${input.period === "daily" ? "каждые московские сутки" : "каждую неделю с понедельника"}, пока игрок подписан: отписался — до новой подписки наград нет.`}
            </Notice>
          ) : null}
          {partner && !channel ? (
            <Notice tone="info">Засчитывается переход по ссылке из игры: проверить, что игрок открыл сайт или запустил бота, без постбэка партнёра нечем.</Notice>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Монеты">
              <Input {...number("coins")} />
            </Field>
            <Field label="Самоцветы" hint="по умолчанию — только достижения">
              <Input {...number("gems")} />
            </Field>
            <Field label="Осколки">
              <Input {...number("shards")} />
            </Field>
            <Field label="Очки пасса" help={HELP.tasks.passPoints}>
              <Input {...number("passPoints")} />
            </Field>
            <Field label="Порядок" help={HELP.tasks.order}>
              <Input {...number("sort")} />
            </Field>
            <label className="flex items-center gap-1.5 pb-1.5 text-sm">
              <input type="checkbox" checked={input.active} onChange={(event) => setInput({ ...input, active: event.target.checked })} />
              включено
            </label>
          </div>
          <Field label={`Заголовок — ${String(input.title?.trim().length ?? 0)} из ${String(TITLE_MAX)}`} hint="пусто — игрок увидит текст по виду цели со склонением числа («Сыграй 3 забега»)">
            <Input value={input.title ?? ""} onChange={(event) => setInput({ ...input, title: event.target.value === "" ? null : event.target.value })} maxLength={TITLE_MAX + 20} className="w-full max-w-xl" />
          </Field>
          {original === null ? null : <Notice tone="info">{channel ? "Повтор" : "Срок"} и вид не меняются: прогресс игроков записан по ним. Нужно другое — заведите новое задание и выключите это.</Notice>}
          <div className="flex gap-2">
            <Button tone="primary" type="submit" disabled={problem !== null || pending}>
              {original === null ? "Завести" : "Сохранить"}
            </Button>
            {original === null ? null : <Button onClick={reset}>Отмена</Button>}
          </div>
          {problem !== null && input.taskId !== "" ? <Notice tone="info">{problem}</Notice> : null}
        </form>
        {outcome === null ? null : <div className="mt-3">{outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}</div>}
      </Panel>

      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok"
        ? groupByPeriod(state.data.tasks).map((group) => (
            <Panel key={group.group} title={GROUP_TITLES[group.group]}>
              <DataTable
                rows={group.tasks}
                rowKey={(task) => task.taskId}
                onRowClick={(task) => {
                  setInput({ ...task });
                  setOriginal(task);
                  setOutcome(null);
                }}
                empty="Пусто — заведите задание выше"
                columns={[
                  { title: "id", render: (task) => <span className="font-mono text-xs">{task.taskId}</span> },
                  { title: "Вид", render: (task) => KIND_TITLES[task.kind] ?? task.kind },
                  { title: "Цель", align: "right", render: (task) => targetLabel(task) },
                  { title: "Заголовок", render: (task) => task.title ?? <span className="text-text-muted">по виду цели</span> },
                  { title: "Награда", render: (task) => rewardLabel(task) },
                  // Счёт выполнивших ведётся у партнёрских целей: у них есть лимит.
                  ...(group.group === "partner"
                    ? [
                        {
                          title: "Выполнили",
                          help: HELP.tasks.completionLimit,
                          align: "right" as const,
                          render: (task: TaskDef) => {
                            const done = completionsLabel(task, state.data.completions[task.taskId] ?? 0);
                            return (
                              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                                {done.text}
                                {done.exhausted ? <Badge tone="warning">мест нет</Badge> : null}
                              </span>
                            );
                          },
                        },
                      ]
                    : []),
                  { title: "Пасс", align: "right", render: (task) => String(task.passPoints) },
                  { title: "Порядок", align: "right", render: (task) => String(task.sort) },
                  { title: "", render: (task) => (task.active ? null : <Badge tone="warning">выключено</Badge>) },
                ]}
              />
            </Panel>
          ))
        : null}
      {state.status === "ok" ? <NetworkTasksPanel rows={state.data.networks} onSaved={reload} /> : null}
    </div>
  );
}
