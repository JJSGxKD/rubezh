import { useEffect, useState, type ReactNode } from "react";
import { BOOSTS } from "@bh/core-game";
import { CoinIcon, GemIcon } from "../design-system/components/CurrencyIcons";
import { formatNumber, t } from "../i18n";
import "../i18n/boosts";
import { loadBoostCatalog, type BoostCatalog } from "../state/boosts-api";
import { useWallet } from "../state/wallet";
import { boostIcon } from "./boost-icons";
import { PickTile } from "./pick-tile";
import { boostTileState, boostToDescribe } from "./pre-run-rules";

/**
 * Бусты на забег в листе «Перед забегом» (docs/35-stage4-plan.md §3.5, Р39,
 * Р88). Цены — с сервера; что буст делает — из контента движка. Без сети
 * раздела нет: буст покупается только онлайн (Р17), и предложить его без сети
 * значило бы пообещать то, чего не выдать.
 *
 * Отдельным чанком вместе с листом: каталог, тексты и значки не нужны первой
 * загрузке.
 */

export interface BoostPickerProps {
  selected: readonly string[];
  /** какой буст тронули последним — его и описывает лист под плитками */
  touched: string | null;
  onChange(selected: string[]): void;
  onTouch(id: string): void;
  /** каталог пришёл — он нужен покупке для цен в аналитике */
  onCatalog(catalog: BoostCatalog | null): void;
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

  const described = BOOSTS.find((boost) => boost.id === boostToDescribe(props.touched, props.selected));
  const wallet = balances === null ? null : { coins: balances.coins, gems: balances.gems };

  return (
    <>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <h2 className="font-display text-xs font-semibold tracking-widest text-text-muted uppercase">{t("boosts.title")}</h2>
        <span className="text-xs text-text-muted tabular-nums">{t("prerun.boosts.count", { count: props.selected.length, max: catalog.maxPerRun })}</span>
      </div>
      <ul className="grid grid-cols-3 gap-1.5">
        {BOOSTS.map((boost) => {
          const price = catalog.boosts.find((entry) => entry.id === boost.id);
          if (price === undefined || (price.resource !== "coins" && price.resource !== "gems")) return null;
          const { chosen, disabled } = boostTileState({
            id: boost.id,
            selected: props.selected,
            price: { resource: price.resource, amount: price.amount },
            catalog: catalog.boosts,
            balances: wallet,
            maxPerRun: catalog.maxPerRun,
          });
          const Icon = boostIcon(boost.id);
          return (
            <li key={boost.id} className="min-w-0">
              <PickTile
                icon={<Icon size={16} aria-hidden="true" />}
                tone="info"
                name={t(boost.nameKey)}
                corner={
                  <>
                    {price.resource === "gems" ? <GemIcon size={12} /> : <CoinIcon size={12} />}
                    {formatNumber(price.amount)}
                  </>
                }
                selected={chosen}
                disabled={disabled}
                onClick={() => {
                  props.onTouch(boost.id);
                  props.onChange(chosen ? props.selected.filter((id) => id !== boost.id) : [...props.selected, boost.id]);
                }}
              />
            </li>
          );
        })}
      </ul>
      <div className="surface-sunken mt-2 rounded-md px-2.5 py-2 text-xs leading-snug text-text-muted">
        {described === undefined ? (
          t("prerun.boosts.hint")
        ) : (
          <>
            <b className="mr-1.5 font-display text-[13px] font-normal text-text">{t(described.nameKey)}</b>
            {t(described.descriptionKey)}
          </>
        )}
      </div>
    </>
  );
}
