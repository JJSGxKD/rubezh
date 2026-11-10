import { useEffect, useState, type FormEvent } from "react";
import type { ApiError } from "../../api/client";
import {
  ACHIEVEMENT_CATEGORIES,
  CATEGORY_TITLES,
  CHANNEL_KIND,
  CHANNEL_PLATFORMS,
  CHANNEL_PLATFORM_TITLES,
  FILTER_KEYS,
  FILTER_LABELS,
  FILTER_OPTIONS,
  GROUP_TITLES,
  HINT_MAX,
  KIND_TITLES,
  LADDER_MAX,
  NO_ACHIEVEMENT_FIELDS,
  NO_CATEGORY_TITLE,
  NO_TIER_TITLE,
  PARTNER_KINDS,
  PARTNER_PLATFORMS,
  PARTNER_PLATFORM_TITLES,
  PERIOD_TITLES,
  POOL_TIERS,
  PRESTIGE_MAX,
  REPEAT_TITLES,
  RUNG_MAX,
  STATE_KINDS,
  TASK_LIMIT_RANGE,
  TASK_PERIODS,
  TIER_TITLES,
  TIME_KINDS,
  TITLE_MAX,
  completionsLabel,
  fetchTasks,
  groupByPeriod,
  isAchievement,
  partnerPlatforms,
  reorderTasks,
  rewardLabel,
  saveTask,
  targetLabel,
  taskPreview,
  taskProblem,
  togglePlatform,
  withKind,
  withPeriod,
  withPlatform,
  type PoolTier,
  type TaskGroup,
  type TaskParams,
  type TaskDef,
} from "../../api/tasks";
import { imageUrl } from "../../api/media";
import { api } from "../../services";
import { ImageField } from "../../ui/image-field";
import { FormDialog, isDirty } from "../../ui/form-dialog";
import { PhonePreview } from "../../ui/phone-preview";
import { Badge, Button, DataTable, ErrorNotice, Field, FieldRow, Input, Loading, Notice, Panel, RowItem, Select } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { applyOrder } from "../../ui/sortable-order";
import { useApi } from "../../ui/use-api";
import { NetworkTasksPanel } from "./NetworkTasksPanel";

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

const EMPTY: TaskDef = { taskId: "", period: "daily", kind: "runs", params: null, filter: null, tier: null, target: 1, title: null, coins: 0, gems: 0, shards: 0, passPoints: 0, sort: 0, active: true, limit: null, image: null, ...NO_ACHIEVEMENT_FIELDS };

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
  // Значения при открытии окна: по ним видно, тронул ли оператор форму.
  const [initial, setInitial] = useState<TaskDef>(EMPTY);
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  /** Новый порядок группы сразу, пока запрос в пути: без него строка прыгала бы назад и вперёд. */
  const [override, setOverride] = useState<{ group: TaskGroup; ids: string[] } | null>(null);
  /** Пока запрос порядка в пути, ручки неактивны: второй порядок поверх первого дал бы гонку. */
  const [reordering, setReordering] = useState(false);

  const catalog = state.status === "ok" ? state.data.tasks : [];
  const kinds = state.status === "ok" ? state.data.kinds : Object.keys(KIND_TITLES);
  const problem = taskProblem(input, original === null, catalog);

  const reset = () => {
    setOpen(false);
    setInput(EMPTY);
    setOriginal(null);
    setFormError(null);
  };

  const openForm = (task: TaskDef | null) => {
    const value = task === null ? EMPTY : { ...task };
    setInput(value);
    setInitial(value);
    setOriginal(task);
    setOutcome(null);
    setFormError(null);
    setOpen(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    setPending(true);
    setFormError(null);
    const result = await saveTask(api, input);
    setPending(false);
    if (!result.ok) return setFormError(result.error.message);
    setOutcome({ tone: "success", text: original === null ? `Задание ${result.data.taskId} заведено — игроки увидят его в течение полуминуты` : `Задание ${result.data.taskId} сохранено` });
    reset();
    reload();
  };

  const partner = PARTNER_KINDS.has(input.kind);
  const filterKey = FILTER_KEYS[input.kind];
  const pooled = !partner && input.period !== "achievement";
  const achievement = isAchievement(input);
  const stateKind = STATE_KINDS.has(input.kind);
  const channel = input.kind === CHANNEL_KIND;
  const setParams = (patch: Partial<TaskParams>) => setInput({ ...input, params: { ...(input.params ?? { url: "" }), ...patch } });

  // Показанный порядок держится, пока не придёт перечитанный каталог: иначе строки на мгновение прыгали бы назад.
  const loaded = state.status === "ok" ? state.data : null;
  useEffect(() => setOverride(null), [loaded]);

  const move = async (group: TaskGroup, ids: string[]) => {
    setOverride({ group, ids });
    setReordering(true);
    setOutcome(null);
    const result = await reorderTasks(api, group, ids);
    setReordering(false);
    // При ошибке (в том числе 400: список мог измениться у другого администратора) порядок возвращается к серверному.
    if (!result.ok) setOverride(null);
    setOutcome(result.ok ? { tone: "success", text: "Порядок сохранён" } : { tone: "danger", error: result.error });
    reload();
  };

  const number = (field: "target" | "coins" | "gems" | "shards" | "passPoints") => ({
    value: String(input[field]),
    onChange: (event: { target: { value: string } }) => setInput({ ...input, [field]: event.target.value === "" ? 0 : Number(event.target.value) }),
    type: "number",
    min: 0,
    step: 1,
    className: "w-24",
  });

  return (
    <div className="flex flex-col gap-4">
      {outcome === null ? null : outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}
      <FormDialog
        open={open}
        wide
        title={original === null ? "Новое задание" : `Задание ${original.taskId}`}
        dirty={isDirty(initial, input)}
        onClose={reset}
        footer={(requestClose) => (
          <>
            {formError === null ? null : <span className="mr-auto text-sm text-danger">{formError}</span>}
            <Button onClick={requestClose}>Отмена</Button>
            <Button tone="primary" type="submit" form="task-form" disabled={problem !== null || pending} blockedBy={pending ? null : problem}>
              {original === null ? "Завести" : "Сохранить"}
            </Button>
          </>
        )}
      >
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto]">
        <form id="task-form" onSubmit={(event) => void submit(event)} className="flex min-w-0 flex-col gap-3">
          <FieldRow>
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
                <Select value={input.period} disabled={original !== null || partner || stateKind} onChange={(event) => setInput(withPeriod(input, TASK_PERIODS.find((period) => period === event.target.value) ?? "daily"))}>
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
            {filterKey === undefined ? null : (
              <Field label={`Фильтр: ${FILTER_LABELS[filterKey]}`} help={HELP.tasks.filter}>
                <Select
                  value={input.filter?.[filterKey] ?? ""}
                  onChange={(event) => setInput({ ...input, filter: event.target.value === "" ? null : { [filterKey]: event.target.value } })}
                >
                  <option value="">выберите</option>
                  {Object.entries(FILTER_OPTIONS[filterKey]).map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {pooled ? (
              <Field label="Ступень" help={HELP.tasks.tier}>
                <Select value={input.tier ?? ""} onChange={(event) => setInput({ ...input, tier: POOL_TIERS.find((tier) => tier === event.target.value) ?? null })}>
                  <option value="">{NO_TIER_TITLE}</option>
                  {POOL_TIERS.map((tier) => (
                    <option key={tier} value={tier}>
                      {TIER_TITLES[tier]}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {partner ? null : (
              <Field label="Цель" hint={TIME_KINDS.has(input.kind) ? `в секундах: ${targetLabel(input)}` : undefined}>
                <Input {...number("target")} min={1} />
              </Field>
            )}
          </FieldRow>
          {partner ? (
            <ImageField label="Картинка" help={HELP.tasks.image} profile="task" value={input.image} onChange={(image) => setInput({ ...input, image })} />
          ) : null}
          {partner ? (
            <FieldRow>
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
                  <span className="text-xs text-text-muted">ничего не отмечено — на всех площадках</span>
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
            </FieldRow>
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
          {achievement ? (
            <FieldRow>
              <Field label="Категория" help={HELP.tasks.category}>
                <Select value={input.category ?? ""} onChange={(event) => setInput({ ...input, category: ACHIEVEMENT_CATEGORIES.find((category) => category === event.target.value) ?? null })}>
                  <option value="">{NO_CATEGORY_TITLE}</option>
                  {ACHIEVEMENT_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {CATEGORY_TITLES[category]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Лестница" help={HELP.tasks.ladder} hint="латиница, пусто — без лестницы">
                <Input
                  value={input.ladder ?? ""}
                  onChange={(event) => setInput({ ...input, ladder: event.target.value === "" ? null : event.target.value.trim(), rung: event.target.value.trim() === "" ? null : (input.rung ?? 1) })}
                  placeholder="kills"
                  maxLength={LADDER_MAX}
                  className="w-32"
                />
              </Field>
              <Field label="Ступень лестницы" help={HELP.tasks.ladder}>
                <Input
                  value={input.rung === null ? "" : String(input.rung)}
                  disabled={(input.ladder ?? "") === ""}
                  onChange={(event) => setInput({ ...input, rung: event.target.value.trim() === "" ? null : Number(event.target.value) })}
                  type="number"
                  min={1}
                  max={RUNG_MAX}
                  step={1}
                  className="w-24"
                />
              </Field>
              <Field label="Престиж" help={HELP.tasks.prestige} hint={`0–${PRESTIGE_MAX.toLocaleString("ru-RU")}`}>
                <Input
                  value={String(input.prestige)}
                  onChange={(event) => setInput({ ...input, prestige: event.target.value === "" ? 0 : Number(event.target.value) })}
                  type="number"
                  min={0}
                  max={PRESTIGE_MAX}
                  step={1}
                  className="w-24"
                />
              </Field>
              <RowItem>
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={input.hidden} onChange={(event) => setInput({ ...input, hidden: event.target.checked })} />
                  скрытое
                </label>
              </RowItem>
              <Field label={`Подсказка — ${String(input.hint?.trim().length ?? 0)} из ${String(HINT_MAX)}`} help={HELP.tasks.hint}>
                <Input value={input.hint ?? ""} onChange={(event) => setInput({ ...input, hint: event.target.value === "" ? null : event.target.value })} maxLength={HINT_MAX + 20} className="w-80" />
              </Field>
            </FieldRow>
          ) : null}
          <FieldRow>
            <Field label="Монеты">
              <Input {...number("coins")} />
            </Field>
            <Field label="Самоцветы" hint="по умолчанию — только достижения">
              <Input {...number("gems")} />
            </Field>
            <Field label="Осколки">
              <Input {...number("shards")} />
            </Field>
            <Field label="Очки заданий" help={HELP.tasks.passPoints}>
              <Input {...number("passPoints")} />
            </Field>
            <RowItem>
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={input.active} onChange={(event) => setInput({ ...input, active: event.target.checked })} />
                включено
              </label>
            </RowItem>
          </FieldRow>
          <Field label={`Заголовок — ${String(input.title?.trim().length ?? 0)} из ${String(TITLE_MAX)}`} hint="пусто — игрок увидит текст по виду цели со склонением числа («Сыграй 3 забега»)">
            <Input value={input.title ?? ""} onChange={(event) => setInput({ ...input, title: event.target.value === "" ? null : event.target.value })} maxLength={TITLE_MAX + 20} className="w-full max-w-xl" />
          </Field>
          {original === null ? null : <Notice tone="info">{channel ? "Повтор" : "Срок"} и вид не меняются: прогресс игроков записан по ним. Нужно другое — заведите новое задание и выключите это.</Notice>}
        </form>
          {/* Строка так, как её увидит игрок в «Заданиях», — до выполнения и готовой к забору (Р83). */}
          <div className="min-w-0 md:sticky md:top-0 md:self-start">
            <PhonePreview kind="task" draft={taskPreview(input)} height={320} caption="Так увидит игрок — вкладка заданий" />
          </div>
        </div>
      </FormDialog>

      {state.status === "ok" ? <RotationPanel rotation={state.data.rotation} catalog={state.data.tasks} /> : null}
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok"
        ? groupByPeriod(state.data.tasks).map((group, index) => (
            <Panel
              key={group.group}
              title={GROUP_TITLES[group.group]}
              help={HELP.tasks.order}
              {...(index === 0
                ? {
                    actions: (
                      <Button tone="primary" onClick={() => openForm(null)}>
                        Новое задание
                      </Button>
                    ),
                  }
                : {})}
            >
              <DataTable
                rows={override?.group === group.group ? applyOrder(group.tasks, override.ids, (task) => task.taskId) : group.tasks}
                reorder={{ labelOf: (task) => task.taskId, onReorder: (ids) => void move(group.group, ids), disabled: reordering }}
                rowKey={(task) => task.taskId}
                onRowClick={openForm}
                empty="Пусто — заведите кнопкой «Новое задание»"
                columns={[
                  { title: "id", render: (task) => <span className="font-mono text-xs">{task.taskId}</span> },
                  { title: "Вид", render: (task) => KIND_TITLES[task.kind] ?? task.kind },
                  // Ступень — у дневных и недельных: из ступени пула берётся набор дня.
                  ...(group.group === "daily" || group.group === "weekly"
                    ? [{ title: "Ступень", render: (task: TaskDef) => (task.tier === null ? <span className="text-text-muted">всегда</span> : TIER_TITLES[task.tier]) }]
                    : []),
                  { title: "Цель", align: "right", render: (task) => targetLabel(task) },
                  {
                    title: "Заголовок",
                    render: (task) => (
                      <span className="inline-flex items-center gap-2">
                        {/* Картинку видно в списке: задание без неё — у игрока со значком вида. */}
                        {task.image === null ? null : <img src={imageUrl(task.image)} alt="" width={24} height={24} loading="lazy" className="size-6 shrink-0 rounded-sm bg-surface-sunken object-cover" />}
                        {task.title ?? <span className="text-text-muted">по виду цели</span>}
                      </span>
                    ),
                  },
                  // Категория, лестница и престиж — у достижений: по ним витрина раскладывает список.
                  ...(group.group === "achievement"
                    ? [
                        {
                          title: "Категория",
                          help: HELP.tasks.category,
                          render: (task: TaskDef) => (task.category === null ? <span className="text-text-muted">нет</span> : CATEGORY_TITLES[task.category]),
                        },
                        {
                          title: "Лестница",
                          render: (task: TaskDef) =>
                            task.ladder === null ? <span className="text-text-muted">нет</span> : <span className="whitespace-nowrap font-mono text-xs">{`${task.ladder} · ${String(task.rung ?? "?")}`}</span>,
                        },
                        { title: "Престиж", help: HELP.tasks.prestige, align: "right" as const, render: (task: TaskDef) => String(task.prestige) },
                      ]
                    : []),
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
                  { title: "Очки", align: "right", render: (task) => String(task.passPoints) },
                  {
                    title: "",
                    render: (task) => (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {task.hidden ? <Badge tone="neutral">скрытое</Badge> : null}
                        {task.active ? null : <Badge tone="warning">выключено</Badge>}
                      </span>
                    ),
                  },
                ]}
              />
            </Panel>
          ))
        : null}
      {state.status === "ok" ? <NetworkTasksPanel rows={state.data.networks} onSaved={reload} /> : null}
    </div>
  );
}

/**
 * Что в ротации сейчас: id набора дня и недели по тем же правилам, что у
 * игрока. Правка пула в течение суток меняет набор у всех сразу — правят
 * вечером.
 */
function RotationPanel({ rotation, catalog }: { rotation: { daily: string[]; weekly: string[] }; catalog: readonly TaskDef[] }) {
  const tierOf = (taskId: string): PoolTier | null => catalog.find((task) => task.taskId === taskId)?.tier ?? null;
  const list = (ids: readonly string[]) =>
    ids.length === 0 ? (
      <span className="text-text-muted">пул пуст</span>
    ) : (
      ids.map((id) => (
        <span key={id} className="mr-3 inline-block whitespace-nowrap font-mono text-xs">
          {id}
          {tierOf(id) === null ? null : <span className="text-text-muted"> · {TIER_TITLES[tierOf(id) ?? "easy"].toLowerCase()}</span>}
        </span>
      ))
    );
  return (
    <Panel title="Сегодня в ротации">
      <div className="flex flex-col gap-2 text-sm">
        <div>
          <span className="mr-2 text-text-muted">День:</span>
          {list(rotation.daily)}
        </div>
        <div>
          <span className="mr-2 text-text-muted">Неделя:</span>
          {list(rotation.weekly)}
        </div>
        <Notice tone="info">Правка пула в течение суток меняет сегодняшний набор у всех игроков — правьте вечером.</Notice>
      </div>
    </Panel>
  );
}
