import { useState, type FormEvent } from "react";
import {
  AD_DEVICES,
  AD_PLACES,
  AD_PLATFORMS,
  AD_SUCCESS,
  DAYS_TITLES,
  DEVICE_TITLES,
  EXTERNAL_ID_MAX,
  FUNNEL_DAYS,
  MIN_NETWORKS_PER_PLACE,
  PLACE_TITLES,
  SUCCESS_TITLES,
  blockProblem,
  coverage,
  fetchAds,
  funnelNetworkTitle,
  percent,
  priorityProblem,
  reachLabel,
  saveBlock,
  saveNetwork,
  type AdBlock,
  type AdBlockInput,
  type AdNetwork,
  type AdsView,
  type FunnelDays,
} from "../../api/ads";
import type { ApiError } from "../../api/client";
import { api } from "../../services";
import { useSession } from "../../state/use-session";
import { Badge, Button, DataTable, ErrorNotice, Field, Input, Loading, Notice, Panel, Select } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { useApi } from "../../ui/use-api";

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

const EMPTY_BLOCK: AdBlockInput = { blockId: null, networkKey: "", place: "wheel_spin", externalId: "", success: "view", active: true, platforms: [], devices: [] };

/**
 * Реклама (docs/29-admin-panel.md, WP12): какие сети показываются и в каком
 * порядке, блоки мест из кабинетов сетей и воронка показов. Правка видна
 * выдаче показов в пределах полуминуты. Сети приходят кодом — у каждой свой
 * SDK, — панель их включает и ставит в круг. Сеть и место у блока после
 * создания не меняются: нужен другой — заводится новый, а старый выключается.
 */
export function AdsScreen() {
  const [days, setDays] = useState<FunnelDays>(7);
  const { state, reload } = useApi(() => fetchAds(api, days), [days]);
  const canEdit = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("ads.edit"));

  return (
    <div className="flex flex-col gap-4">
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <>
          <CoveragePanel view={state.data} />
          <NetworksPanel networks={state.data.networks} canEdit={canEdit} onSaved={reload} />
          <BlocksPanel view={state.data} canEdit={canEdit} onSaved={reload} />
          <FunnelPanel view={state.data} days={days} onDays={setDays} />
        </>
      ) : null}
    </div>
  );
}

function CoveragePanel({ view }: { view: AdsView }) {
  return (
    <Panel title="Покрытие мест" help={HELP.ads.coverage}>
      <DataTable
        rows={coverage(view)}
        rowKey={(row) => row.place}
        columns={[
          { title: "Место", render: (row) => PLACE_TITLES[row.place] },
          { title: "Сети по кругу", help: HELP.ads.circle, render: (row) => (row.networks.length === 0 ? <span className="text-text-muted">нет — игрок увидит «реклама недоступна»</span> : row.networks.join(" → ")) },
          {
            title: "",
            render: (row) =>
              row.networks.length >= MIN_NETWORKS_PER_PLACE ? null : <Badge tone="warning">{row.networks.length === 0 ? "пусто" : "одна сеть — отказ оставит место пустым"}</Badge>,
          },
        ]}
      />
    </Panel>
  );
}

function NetworksPanel({ networks, canEdit, onSaved }: { networks: AdNetwork[]; canEdit: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState<AdNetwork | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const problem = editing === null ? null : priorityProblem(editing.priority);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (editing === null || problem !== null) return;
    setPending(true);
    const result = await saveNetwork(api, editing);
    setPending(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: `${result.data.name}: ${result.data.active ? "включена" : "выключена"}, место в круге ${String(result.data.priority)}` });
    setEditing(null);
    onSaved();
  };

  return (
    <Panel title="Сети" help={HELP.ads.networks}>
      {editing === null ? null : (
        <form onSubmit={(event) => void submit(event)} className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="Сеть">
            <span className="block py-1.5 text-sm font-medium">{editing.name}</span>
          </Field>
          <Field label="Место в круге" hint="меньше — раньше" help={HELP.ads.priority}>
            <Input type="number" min={0} step={1} value={String(editing.priority)} onChange={(event) => setEditing({ ...editing, priority: event.target.value === "" ? 0 : Number(event.target.value) })} className="w-24" />
          </Field>
          <label className="flex items-center gap-1.5 pb-1.5 text-sm">
            <input type="checkbox" checked={editing.active} onChange={(event) => setEditing({ ...editing, active: event.target.checked })} />
            включена
          </label>
          <Button tone="primary" type="submit" disabled={problem !== null || pending}>
            Сохранить
          </Button>
          <Button onClick={() => setEditing(null)}>Отмена</Button>
          {problem === null ? null : <Notice tone="info">{problem}</Notice>}
        </form>
      )}
      <DataTable
        rows={networks}
        rowKey={(network) => network.networkKey}
        onRowClick={
          canEdit
            ? (network) => {
                setEditing({ ...network });
                setOutcome(null);
              }
            : undefined
        }
        columns={[
          { title: "Сеть", render: (network) => network.name },
          { title: "Ключ", render: (network) => <span className="font-mono text-xs">{network.networkKey}</span> },
          { title: "Место в круге", align: "right", render: (network) => String(network.priority) },
          { title: "", render: (network) => (network.active ? <Badge tone="success">включена</Badge> : <Badge>выключена</Badge>) },
        ]}
      />
      {outcome === null ? null : <div className="mt-3">{outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}</div>}
    </Panel>
  );
}

function BlocksPanel({ view, canEdit, onSaved }: { view: AdsView; canEdit: boolean; onSaved: () => void }) {
  const [input, setInput] = useState<AdBlockInput>({ ...EMPTY_BLOCK, networkKey: view.networks[0]?.networkKey ?? "" });
  const [original, setOriginal] = useState<AdBlock | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const problem = blockProblem(input, view.networks);
  const networkName = (key: string) => view.networks.find((network) => network.networkKey === key)?.name ?? key;

  const reset = () => {
    setInput({ ...EMPTY_BLOCK, networkKey: input.networkKey, place: input.place });
    setOriginal(null);
  };

  const toggle = <T extends string>(list: readonly T[], value: T, on: boolean): T[] => (on ? [...list, value] : list.filter((item) => item !== value));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    setPending(true);
    const result = await saveBlock(api, input);
    setPending(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: `${original === null ? "Блок заведён" : "Блок сохранён"}: ${networkName(result.data.networkKey)}, ${PLACE_TITLES[result.data.place]} — выдача увидит его в течение полуминуты` });
    reset();
    onSaved();
  };

  return (
    <Panel title="Блоки мест" help={HELP.ads.blocks}>
      {canEdit ? (
        <form onSubmit={(event) => void submit(event)} className="mb-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Сеть">
              <Select value={input.networkKey} disabled={original !== null} onChange={(event) => setInput({ ...input, networkKey: event.target.value })}>
                {view.networks.map((network) => (
                  <option key={network.networkKey} value={network.networkKey}>
                    {network.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Место">
              <Select value={input.place} disabled={original !== null} onChange={(event) => setInput({ ...input, place: AD_PLACES.find((place) => place === event.target.value) ?? "wheel_spin" })}>
                {AD_PLACES.map((place) => (
                  <option key={place} value={place}>
                    {PLACE_TITLES[place]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Блок в кабинете сети" help={HELP.ads.externalId}>
              <Input value={input.externalId} onChange={(event) => setInput({ ...input, externalId: event.target.value })} maxLength={EXTERNAL_ID_MAX + 10} placeholder="int-12345" className="w-64 font-mono" />
            </Field>
            <Field label="Успех" help={HELP.ads.success}>
              <Select value={input.success} onChange={(event) => setInput({ ...input, success: AD_SUCCESS.find((success) => success === event.target.value) ?? "view" })}>
                {AD_SUCCESS.map((success) => (
                  <option key={success} value={success}>
                    {SUCCESS_TITLES[success]}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-center gap-1.5 pb-1.5 text-sm">
              <input type="checkbox" checked={input.active} onChange={(event) => setInput({ ...input, active: event.target.checked })} />
              включён
            </label>
          </div>
          <div className="flex flex-wrap gap-6 text-sm">
            <fieldset className="flex flex-wrap items-center gap-3">
              <legend className="mb-1 text-xs text-text-muted">Площадки — ни одной: все</legend>
              {AD_PLATFORMS.map((platform) => (
                <label key={platform} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={input.platforms.includes(platform)} onChange={(event) => setInput({ ...input, platforms: toggle(input.platforms, platform, event.target.checked) })} />
                  {platform}
                </label>
              ))}
            </fieldset>
            <fieldset className="flex flex-wrap items-center gap-3">
              <legend className="mb-1 text-xs text-text-muted">Устройства — ни одного: все</legend>
              {AD_DEVICES.map((device) => (
                <label key={device} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={input.devices.includes(device)} onChange={(event) => setInput({ ...input, devices: toggle(input.devices, device, event.target.checked) })} />
                  {DEVICE_TITLES[device]}
                </label>
              ))}
            </fieldset>
          </div>
          <p className="text-xs text-text-muted">Показ засчитывает ответ SDK; клик и целевое действие — только подтверждение сервера: свой редирект и постбэк сети.</p>
          {original === null ? null : <Notice tone="info">Сеть и место не меняются: по ним посчитана воронка. Нужен другой — заведите новый блок и выключите этот.</Notice>}
          <div className="flex gap-2">
            <Button tone="primary" type="submit" disabled={problem !== null || pending}>
              {original === null ? "Завести" : "Сохранить"}
            </Button>
            {original === null ? null : <Button onClick={reset}>Отмена</Button>}
          </div>
          {problem !== null && input.externalId !== "" ? <Notice tone="info">{problem}</Notice> : null}
          {outcome === null ? null : outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}
        </form>
      ) : null}
      <DataTable
        rows={view.blocks}
        rowKey={(block) => block.blockId}
        onRowClick={
          canEdit
            ? (block) => {
                setInput({ ...block });
                setOriginal(block);
                setOutcome(null);
              }
            : undefined
        }
        empty="Блоков нет — заведите блок из кабинета сети выше"
        columns={[
          { title: "Место", render: (block) => PLACE_TITLES[block.place] },
          { title: "Сеть", render: (block) => networkName(block.networkKey) },
          { title: "Блок", render: (block) => <span className="font-mono text-xs">{block.externalId}</span> },
          { title: "Успех", render: (block) => SUCCESS_TITLES[block.success] },
          { title: "Где", help: HELP.ads.reach, render: (block) => reachLabel(block) },
          { title: "", render: (block) => (block.active ? null : <Badge tone="warning">выключен</Badge>) },
        ]}
      />
    </Panel>
  );
}

function FunnelPanel({ view, days, onDays }: { view: AdsView; days: FunnelDays; onDays: (days: FunnelDays) => void }) {
  const networkName = (key: string) => funnelNetworkTitle(key, view.networks);
  return (
    <Panel
      title="Воронка показов"
      help={HELP.ads.funnel}
      actions={
        <Select value={String(days)} onChange={(event) => onDays(FUNNEL_DAYS.find((option) => String(option) === event.target.value) ?? 7)}>
          {FUNNEL_DAYS.map((option) => (
            <option key={option} value={option}>
              {DAYS_TITLES[option]}
            </option>
          ))}
        </Select>
      }
    >
      <DataTable
        rows={view.funnel}
        rowKey={(row) => `${row.place}:${row.networkKey}`}
        empty="Показов за это время не было"
        columns={[
          { title: "Место", render: (row) => PLACE_TITLES[row.place] },
          { title: "Сеть", render: (row) => networkName(row.networkKey) },
          { title: "Выдано", help: HELP.ads.offered, align: "right", render: (row) => String(row.offered) },
          { title: "Показано", help: HELP.ads.shown, align: "right", render: (row) => <Ratio part={row.shown} whole={row.offered} /> },
          { title: "Клики", align: "right", render: (row) => String(row.clicked) },
          { title: "Выполнено", help: HELP.ads.completed, align: "right", render: (row) => <Ratio part={row.completed} whole={row.offered} /> },
          { title: "Награды", help: HELP.ads.claimed, align: "right", render: (row) => String(row.claimed) },
          { title: "Отказы", help: HELP.ads.failed, align: "right", render: (row) => <Ratio part={row.failed} whole={row.offered} /> },
        ]}
      />
    </Panel>
  );
}

/** Число и доля от выданных — одной строкой: перенос посреди «27 · 28%» читается как два числа. */
function Ratio({ part, whole }: { part: number; whole: number }) {
  return <span className="whitespace-nowrap">{`${String(part)} · ${percent(part, whole)}`}</span>;
}
