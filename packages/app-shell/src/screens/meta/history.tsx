import { useEffect, useState, type ReactNode } from "react";
import { Package, Zap } from "lucide-react";
import { Button, Card, ContentColumn, ErrorState, InfoNotice, Screen } from "../../design-system/components";
import { CoinIcon, GemIcon } from "../../design-system/components/CurrencyIcons";
import { ShardIcon, shardRarity } from "../../design-system/components/ShardIcon";
import { StarsIcon } from "../../design-system/components/StarsIcon";
import { formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/arsenal";
import "../../i18n/history";
import { createHistoryApi, historyAvailable, HISTORY_FILTERS, type HistoryEntry, type HistoryFilter } from "../../state/history-api";
import { useNavigation } from "../../state/navigation";
import { formatWhen } from "../../state/notifications-api";

/**
 * История имущества (docs/35-stage4-plan.md Р51, §3.17): все движения
 * валют, осколков, предметов, бустов и покупок одной лентой, с фильтром по
 * категориям. Источник — журналы на сервере, поэтому лента сходится с
 * балансом.
 */

type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; entries: HistoryEntry[]; cursor: string | null };

const api = createHistoryApi();

export function HistoryScreen(): ReactNode {
  const navigation = useNavigation();
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [more, setMore] = useState(false);

  const load = async (next: HistoryFilter): Promise<void> => {
    setState({ status: "loading" });
    const response = await api.page(next, null);
    setState(response.ok ? { status: "ready", entries: response.data.entries, cursor: response.data.nextCursor } : { status: "failed" });
  };

  useEffect(() => {
    if (historyAvailable()) void load(filter);
  }, [filter]);

  const loadMore = async (): Promise<void> => {
    if (state.status !== "ready" || state.cursor === null) return;
    setMore(true);
    const response = await api.page(filter, state.cursor);
    setMore(false);
    if (response.ok) setState({ status: "ready", entries: [...state.entries, ...response.data.entries], cursor: response.data.nextCursor });
  };

  return (
    <Screen title={t("history.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        {!historyAvailable() ? (
          <InfoNotice text={t("history.guest")} />
        ) : (
          <>
            <p className="text-sm text-text-muted">{t("history.intro")}</p>
            {/* Фильтры — своей прокруткой: на узком экране шесть кнопок не
                помещаются, а страница вбок не прокручивается. */}
            <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label={t("history.title")}>
              {HISTORY_FILTERS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={id === filter}
                  onClick={() => setFilter(id)}
                  className={`shrink-0 rounded-pill px-3 py-1.5 text-sm font-semibold transition-transform active:scale-95 ${id === filter ? "bg-accent text-on-accent" : "surface-sunken text-text-muted"}`}
                >
                  {t(`history.filter.${id}`)}
                </button>
              ))}
            </div>

            <div className="mt-3">
              {state.status === "loading" ? <p className="text-sm text-text-muted">{t("history.loading")}</p> : null}
              {state.status === "failed" ? <ErrorState text={t("history.failed")} onRetry={() => void load(filter)} /> : null}
              {state.status === "ready" && state.entries.length === 0 ? <InfoNotice text={t("history.empty")} /> : null}
              {state.status === "ready" ? (
                <div className="grid gap-2">
                  {state.entries.map((entry) => (
                    <EntryRow key={entry.id} entry={entry} />
                  ))}
                  {state.cursor === null ? null : (
                    <Button variant="secondary" block loading={more} onClick={() => void loadMore()}>
                      {t("history.more")}
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          </>
        )}
      </ContentColumn>
    </Screen>
  );
}

interface Described {
  icon: ReactNode;
  title: string;
  /** сумма со знаком или деталь справа */
  value: string;
  tone: "plus" | "minus" | "plain";
  /** метка во второй строке, рядом со временем */
  note?: string;
}

function describe(entry: HistoryEntry): Described {
  switch (entry.kind) {
    case "wallet": {
      const reason = `history.reason.${entry.reason}`;
      const resource = `history.resource.${entry.resource}`;
      const sign = entry.amount > 0 ? "+" : "−";
      const amount = Math.abs(entry.amount);
      return {
        icon: walletIcon(entry),
        title: hasTranslation(reason) ? t(reason) : t("history.reason.other"),
        value: `${sign}${formatNumber(amount)} ${hasTranslation(resource) ? t(resource, { n: amount }) : entry.resource}`,
        tone: entry.amount > 0 ? "plus" : "minus",
      };
    }
    case "item": {
      const event = `history.item.${entry.event}`;
      const slot = `arsenal.slot.${entry.slot}`;
      const rarity = `rarity.${entry.rarity}`;
      // Редкость — отдельной меткой, а не прилагательным к слоту: подписи
      // редкостей в среднем роде, а слоты — «пояс», «сапоги», «оружие».
      return {
        icon: <Package size={20} />,
        title: `${hasTranslation(event) ? t(event) : t("history.item.other")}: ${hasTranslation(slot) ? t(slot).toLowerCase() : entry.slot}`,
        value: entry.level === null ? "" : t("history.item.level", { level: entry.level }),
        tone: "plain",
        note: hasTranslation(rarity) ? t(rarity) : entry.rarity,
      };
    }
    case "purchase": {
      const product = `history.purchase.${entry.product}`;
      return {
        icon: <StarsIcon size={20} />,
        title: hasTranslation(product) ? t(product) : t("history.purchase.other"),
        value: entry.refunded ? t("history.purchase.refunded") : t("history.purchase.stars", { stars: entry.stars }),
        tone: entry.refunded ? "plain" : "minus",
      };
    }
  }
}

function EntryRow(props: { entry: HistoryEntry }): ReactNode {
  const described = describe(props.entry);
  const tone = described.tone === "plus" ? "text-success" : described.tone === "minus" ? "text-text" : "text-text-muted";
  return (
    <Card compact>
      <div className="flex items-center gap-3">
        <span className="surface-sunken inline-flex size-9 shrink-0 items-center justify-center rounded-md text-text-muted">{described.icon}</span>
        <div className="min-w-0 flex-1">
          {/* Две строки, а не обрезка: на узком экране сумма осколков
              длинная, и причина иначе схлопнется в «Объединение…». */}
          <p className="line-clamp-2 text-sm text-text">{described.title}</p>
          <p className="text-xs text-text-muted">
            {formatWhen(props.entry.at, Date.now())}
            {described.note === undefined ? null : ` · ${described.note}`}
          </p>
        </div>
        <span className={`shrink-0 font-display text-sm font-bold tabular-nums ${tone}`}>{described.value}</span>
      </div>
    </Card>
  );
}

/** Значок строки кошелька: валюта — своим значком, осколок — общим цвета редкости, буст — молнией. */
function walletIcon(entry: Extract<HistoryEntry, { kind: "wallet" }>): ReactNode {
  if (entry.resource === "coins") return <CoinIcon size={20} />;
  if (entry.resource === "gems") return <GemIcon size={20} />;
  const rarity = shardRarity(entry.resource);
  if (rarity !== null) return <ShardIcon rarity={rarity} size={20} />;
  return entry.category === "boosts" ? <Zap size={20} /> : <Package size={20} />;
}
