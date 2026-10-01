import { useState, type MouseEvent } from "react";
import {
  FILTERS,
  STATE_TITLES,
  STATE_TONES,
  audienceText,
  batchMask,
  fetchPromoCodes,
  rewardText,
  type FilterId,
  type PromoCampaign,
} from "../../api/promo-codes";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Loading, Panel } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { PromoCodeCard } from "./PromoCodeCard";
import { PromoCodeDialog } from "./PromoCodeDialog";

/**
 * Промокоды (docs/35-stage4-plan.md WP41): список с фильтром по состоянию,
 * мастер нового кода и карточка с активациями, паузой и правкой. Действующие
 * — первым фильтром: за ними приходят чаще всего.
 */
export function PromoCodesScreen() {
  const { state, reload } = useApi(() => fetchPromoCodes(api), []);
  const [filter, setFilter] = useState<FilterId | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PromoCampaign | null>(null);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const { campaigns, limits, platforms } = state.data;

  const counts = new Map(FILTERS.map((item) => [item.id, item.states === null ? campaigns.length : campaigns.filter((campaign) => (item.states as readonly string[]).includes(campaign.state)).length]));
  // Пока ничего не выбрано — действующие, если они есть; иначе все.
  const current = filter ?? ((counts.get("active") ?? 0) > 0 ? "active" : "all");
  const states = FILTERS.find((item) => item.id === current)?.states ?? null;
  const rows = states === null ? campaigns : campaigns.filter((campaign) => (states as readonly string[]).includes(campaign.state));

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Промокоды"
        help={HELP.promoCodes.section}
        actions={
          <Button tone="primary" onClick={() => setCreating(true)}>
            Новый промокод
          </Button>
        }
      >
        <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Состояние">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={current === item.id}
              onClick={() => setFilter(item.id)}
              className={`rounded-pill border px-3 py-1 text-xs transition-colors ${current === item.id ? "border-accent bg-accent/15 text-accent" : "border-border text-text-muted hover:border-border-strong hover:text-text"}`}
            >
              {item.title} <span className="opacity-70">{counts.get(item.id) ?? 0}</span>
            </button>
          ))}
        </div>
        <DataTable
          rows={rows}
          rowKey={(campaign) => campaign.campaignId}
          onRowClick={(campaign) => setOpenId(campaign.campaignId)}
          empty={campaigns.length === 0 ? "Промокодов ещё нет — заведите первый кнопкой «Новый промокод»" : "В этом фильтре пусто"}
          columns={[
            { title: "Код", help: HELP.promoCodes.code, render: (campaign) => <CodeCell campaign={campaign} /> },
            {
              title: "Название",
              render: (campaign) => (
                <span className="flex flex-col">
                  <span className="font-medium">{campaign.title}</span>
                  {campaign.note === null ? null : <span className="line-clamp-1 text-xs text-text-muted">{campaign.note}</span>}
                </span>
              ),
            },
            { title: "Награда", render: (campaign) => rewardText(campaign.reward) },
            { title: "Активации", help: HELP.promoCodes.redeemed, render: (campaign) => <Usage campaign={campaign} /> },
            { title: "Срок", render: (campaign) => <PeriodCell campaign={campaign} /> },
            { title: "Кому", render: (campaign) => <span className="text-text-muted">{audienceText(campaign)}</span> },
            { title: "Состояние", help: HELP.promoCodes.state, render: (campaign) => <Badge tone={STATE_TONES[campaign.state] ?? "neutral"}>{STATE_TITLES[campaign.state] ?? campaign.state}</Badge> },
          ]}
        />
      </Panel>

      {creating ? (
        <PromoCodeDialog
          limits={limits}
          platforms={platforms}
          editing={null}
          onClose={() => setCreating(false)}
          onSaved={(campaign) => {
            reload();
            setOpenId(campaign.campaignId);
          }}
        />
      ) : null}
      {editing === null ? null : <PromoCodeDialog limits={limits} platforms={platforms} editing={editing} onClose={() => setEditing(null)} onSaved={() => reload()} />}
      {openId === null || editing !== null || creating ? null : (
        <PromoCodeCard
          campaignId={openId}
          onClose={() => setOpenId(null)}
          onChanged={reload}
          onEdit={(campaign) => setEditing(campaign)}
        />
      )}
    </div>
  );
}

function CodeCell({ campaign }: { campaign: PromoCampaign }) {
  if (campaign.kind === "batch") {
    return (
      <span className="flex flex-col">
        <span className="font-mono text-sm text-text-muted">{batchMask(campaign.codeSample)}</span>
        <span className="text-xs text-text-muted">пачка · {formatNumber(campaign.maxRedemptions ?? 0)} кодов</span>
      </span>
    );
  }
  const copy = (event: MouseEvent) => {
    // Строка таблицы открывает карточку — копирование не должно её открывать.
    event.stopPropagation();
    void navigator.clipboard.writeText(campaign.codeSample).then(
      () => toast.success(`Код ${campaign.codeSample} скопирован`),
      () => toast.error("Браузер не дал скопировать — выделите код вручную"),
    );
  };
  return (
    <button type="button" onClick={copy} title="Скопировать" className="rounded-sm px-1 font-mono text-sm font-semibold tracking-wide hover:bg-surface-raised">
      {campaign.codeSample}
    </button>
  );
}

export function Usage({ campaign }: { campaign: PromoCampaign }) {
  const limit = campaign.maxRedemptions;
  const share = limit === null || limit === 0 ? null : Math.min(1, campaign.redeemed / limit);
  return (
    <span className="flex min-w-28 flex-col gap-1">
      <span className="whitespace-nowrap">
        {formatNumber(campaign.redeemed)}
        <span className="text-text-muted">{limit === null ? " · без лимита" : ` из ${formatNumber(limit)}`}</span>
      </span>
      {share === null ? null : (
        <span className="h-1 w-full overflow-hidden rounded-pill bg-surface-raised">
          <span className={`block h-full ${share >= 1 ? "bg-warning" : "bg-accent"}`} style={{ width: `${String(Math.round(share * 100))}%` }} />
        </span>
      )}
    </span>
  );
}

export function PeriodCell({ campaign }: { campaign: PromoCampaign }) {
  const scheduled = campaign.state === "scheduled";
  return (
    <span className="flex flex-col whitespace-nowrap">
      {scheduled ? <span>с {formatDateTime(campaign.startsAt)}</span> : null}
      <span className={scheduled ? "text-xs text-text-muted" : ""}>{campaign.endsAt === null ? "бессрочно" : `до ${formatDateTime(campaign.endsAt)}`}</span>
    </span>
  );
}
