import { useEffect, useState, type ReactNode } from "react";
import { Eye, Heart, Magnet, Plus, Shield, Swords, type LucideIcon } from "lucide-react";
import { BOOSTS } from "@bh/core-game";
import { SectionTitle } from "../design-system/components";
import { CoinIcon, GemIcon } from "../design-system/components/CurrencyIcons";
import { formatNumber, t } from "../i18n";
import "../i18n/boosts";
import { loadBoostCatalog, type BoostCatalog } from "../state/boosts-api";
import { useWallet } from "../state/wallet";

/**
 * Бусты на забег перед «В бой» (docs/35-stage4-plan.md §3.5, Р39). Цены — с
 * сервера; что буст делает — из контента движка. Без сети раздела нет: буст
 * покупается только онлайн (Р17), и предложить его без сети значило бы
 * пообещать то, чего не выдать.
 *
 * Отдельным чанком: каталог, тексты и значки не нужны первой загрузке.
 */

const ICONS: Record<string, LucideIcon> = {
  fury: Swords,
  bulwark: Heart,
  lure: Magnet,
  aegis: Shield,
  head_start: Plus,
  insight: Eye,
};

export interface BoostPickerProps {
  selected: readonly string[];
  onChange(selected: string[]): void;
  /** каталог пришёл — он нужен покупке для цен в аналитике */
  onCatalog(catalog: BoostCatalog | null): void;
  /** почему покупка не прошла: код ошибки сервера или причина неудачи */
  error: string | null;
}

export function BoostPicker(props: BoostPickerProps): ReactNode {
  const [catalog, setCatalog] = useState<BoostCatalog | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const balances = useWallet((state) => state.balances);
  const { onCatalog } = props;

  useEffect(() => {
    let alive = true;
    void loadBoostCatalog().then((response) => {
      if (!alive) return;
      if (response.ok) {
        setCatalog(response.data);
        onCatalog(response.data);
      } else {
        setUnavailable(response.failure !== "disabled");
        onCatalog(null);
      }
    });
    return () => {
      alive = false;
    };
  }, [onCatalog]);

  if (catalog === null) {
    return unavailable ? <p className="mt-4 text-xs text-text-muted">{t("boosts.offline")}</p> : null;
  }

  const spent = { coins: 0, gems: 0 };
  for (const id of props.selected) {
    const price = catalog.boosts.find((boost) => boost.id === id);
    if (price?.resource === "coins" || price?.resource === "gems") spent[price.resource] += price.amount;
  }

  return (
    <>
      <SectionTitle>{t("boosts.title")}</SectionTitle>
      <p className="mb-3 text-xs text-text-muted">{t("boosts.hint", { max: catalog.maxPerRun })}</p>
      <ul className="grid gap-2 landscape:grid-cols-2">
        {BOOSTS.map((boost) => {
          const price = catalog.boosts.find((entry) => entry.id === boost.id);
          if (price === undefined) return null;
          const chosen = props.selected.includes(boost.id);
          const wallet = price.resource === "gems" ? (balances?.gems ?? 0) : (balances?.coins ?? 0);
          const affordable = chosen || wallet - (price.resource === "gems" ? spent.gems : spent.coins) >= price.amount;
          const full = !chosen && props.selected.length >= catalog.maxPerRun;
          const Icon = ICONS[boost.id] ?? Swords;
          return (
            <li key={boost.id}>
              <button
                type="button"
                aria-pressed={chosen}
                disabled={!chosen && (!affordable || full)}
                onClick={() => props.onChange(chosen ? props.selected.filter((id) => id !== boost.id) : [...props.selected, boost.id])}
                className={[
                  "surface-card flex w-full items-center gap-3 rounded-lg p-3 text-left transition-[transform,opacity] active:scale-[0.98] disabled:opacity-40",
                  chosen ? "ring-2 ring-accent" : "ring-1 ring-border-strong",
                ].join(" ")}
              >
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-info/15 text-info">
                  <Icon size={20} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-display text-base font-bold text-text">{t(boost.nameKey)}</span>
                  <span className="mt-0.5 block text-xs text-text-muted">{t(boost.descriptionKey)}</span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 font-display text-sm font-bold tabular-nums text-text">
                  {price.resource === "gems" ? <GemIcon size={16} /> : <CoinIcon size={16} />}
                  {formatNumber(price.amount)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {props.error === null ? null : (
        <p role="alert" className="mt-2 text-center text-sm text-danger">
          {t(props.error)}
        </p>
      )}
    </>
  );
}
