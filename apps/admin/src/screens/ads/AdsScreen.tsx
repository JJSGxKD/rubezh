import { useState } from "react";
import {
  AD_PLATFORMS,
  DAYS_TITLES,
  FORMAT_TITLES,
  FUNNEL_DAYS,
  MIN_NETWORKS_PER_PLACE,
  PLACE_TITLES,
  PLATFORM_TITLES,
  SUCCESS_TITLES,
  adPlatforms,
  blockServable,
  coverage,
  fetchAds,
  funnelNetworkTitle,
  percent,
  reachLabel,
  type AdBlock,
  type AdsView,
  type FunnelDays,
  type PlaceCoverage,
  type PlatformCoverage,
} from "../../api/ads";
import { hrefOf } from "../../routes";
import { api } from "../../services";
import { useSession } from "../../state/use-session";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Help, Loading, Notice, Panel, Select } from "../../ui/kit";
import { useApi } from "../../ui/use-api";
import { BlockDialog } from "./BlockDialog";
import { NetworkCards } from "./NetworkCards";

/**
 * Реклама (docs/29-admin-panel.md, WP12): какие сети реально показываются в
 * каждом месте, сети с ключами по профилю, блоки мест и воронка показов.
 * Формы строятся по профилям сетей с сервера (часть 5): ключи сети — по виду
 * из кабинета, блок — только в место формата сети. Правка видна выдаче
 * показов в пределах полуминуты.
 */
export function AdsScreen() {
  const [days, setDays] = useState<FunnelDays>(7);
  const { state, reload } = useApi(() => fetchAds(api, days), [days]);
  const canEdit = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("ads.edit"));
  const canSettings = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("settings.edit"));

  return (
    <div className="flex flex-col gap-4">
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <>
          {state.data.testMode ? <TestModeNotice canSettings={canSettings} /> : null}
          <CoveragePanel view={state.data} />
          <NetworkCards view={state.data} canEdit={canEdit} onSaved={reload} />
          <BlocksPanel view={state.data} canEdit={canEdit} onSaved={reload} />
          <FunnelPanel view={state.data} days={days} onDays={setDays} />
        </>
      ) : null}
    </div>
  );
}

/**
 * Тестовые показы — первым на экране: включённые в бою, они тихо съедают
 * доход, а на графиках выглядят как обычные показы.
 */
function TestModeNotice({ canSettings }: { canSettings: boolean }) {
  return (
    <Notice>
      Включены тестовые показы: сети крутят пробные ролики, не засчитывают их и не платят. На тестовом сервере так и задумано, в бою — выключите.{" "}
      {canSettings ? (
        <a className="font-semibold underline" href={hrefOf({ section: "settings", id: "ads.test-mode" })}>
          Выключить в настройках
        </a>
      ) : (
        "Выключает тот, у кого есть доступ к настройкам."
      )}
    </Notice>
  );
}

/**
 * Покрытие — по каждой площадке отдельно (Р77): блок AdsGram «везде» не
 * делает VK покрытой — её SDK там нет. Площадки, где не работает ни одна
 * подключённая сеть, — одной строкой под таблицей: настроить там нечего, и
 * предупреждение на каждом месте только приучало бы их не читать.
 */
function CoveragePanel({ view }: { view: AdsView }) {
  const platforms = adPlatforms(view);
  const without = AD_PLATFORMS.filter((platform) => !platforms.includes(platform));
  return (
    <Panel title="Покрытие мест" help={HELP.ads.coverage}>
      <DataTable
        rows={coverage(view)}
        rowKey={(row) => row.place}
        columns={[
          { title: "Место", render: (row) => PLACE_TITLES[row.place] },
          { title: "Формат", render: (row) => FORMAT_TITLES[view.formats[row.place] ?? ""] ?? view.formats[row.place] ?? "—" },
          ...platforms.map((platform) => ({
            title: platforms.length === 1 ? `Сети по кругу · ${PLATFORM_TITLES[platform]}` : PLATFORM_TITLES[platform],
            help: HELP.ads.circle,
            render: (row: PlaceCoverage) => <CoverageCell cell={row.platforms.find((cell) => cell.platform === platform)} />,
          })),
        ]}
      />
      {without.length === 0 ? null : (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-text-muted">
          {without.map((platform) => PLATFORM_TITLES[platform]).join(", ")}: рекламы нет — ни одна подключённая сеть там не работает.
          <Help text={HELP.ads.platforms} />
        </p>
      )}
    </Panel>
  );
}

function CoverageCell({ cell }: { cell: PlatformCoverage | undefined }) {
  if (cell === undefined || !cell.possible) return <span className="text-text-muted">у сетей нет формата для места</span>;
  if (cell.networks.length === 0) {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Badge tone="warning">пусто</Badge>
        <span className="text-xs text-text-muted">кнопки «за рекламу» у игрока нет, VIP получает награду без ролика</span>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {cell.networks.join(" → ")}
      {cell.networks.length >= MIN_NETWORKS_PER_PLACE ? null : <Badge tone="warning">одна сеть — отказ оставит место пустым</Badge>}
    </span>
  );
}

function BlocksPanel({ view, canEdit, onSaved }: { view: AdsView; canEdit: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState<AdBlock | "new" | null>(null);
  const networkName = (key: string) => view.networks.find((network) => network.networkKey === key)?.name ?? key;

  return (
    <Panel
      title="Блоки мест"
      help={HELP.ads.blocks}
      actions={
        canEdit ? (
          <Button tone="primary" onClick={() => setOpen("new")}>
            Новый блок
          </Button>
        ) : null
      }
    >
      <DataTable
        rows={view.blocks}
        rowKey={(block) => block.blockId}
        onRowClick={canEdit ? (block) => setOpen(block) : undefined}
        empty="Блоков нет — заведите блок кнопкой «Новый блок»"
        columns={[
          { title: "Место", render: (block) => PLACE_TITLES[block.place] },
          { title: "Сеть", render: (block) => networkName(block.networkKey) },
          { title: "Блок", help: HELP.ads.externalId, render: (block) => (block.externalId === null ? <span className="text-text-muted">по ключам сети</span> : <span className="font-mono text-xs">{block.externalId}</span>) },
          { title: "Успех", render: (block) => SUCCESS_TITLES[block.success] },
          { title: "Где", help: HELP.ads.reach, render: (block) => reachLabel(view, block) },
          {
            title: "Состояние",
            render: (block) =>
              block.problem !== null ? (
                <span className="flex flex-col gap-0.5">
                  <Badge tone="danger">не по правилам сети — не выдаётся</Badge>
                  <span className="text-xs text-danger">{block.problem}</span>
                </span>
              ) : !block.active ? (
                <Badge tone="warning">выключен</Badge>
              ) : blockServable(view, block) ? (
                <Badge tone="success">в выдаче</Badge>
              ) : (
                <Badge>ждёт сеть: включить и задать ключи</Badge>
              ),
          },
        ]}
      />
      {open === null ? null : <BlockDialog view={view} block={open} onClose={() => setOpen(null)} onSaved={onSaved} />}
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
