import { useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Badge, Button, Card, ErrorState, Modal, SectionTitle } from "../../design-system/components";
import { GemIcon } from "../../design-system/components/CurrencyIcons";
import { formatNumber, t } from "../../i18n";
import "../../i18n/arsenal";
import type { ShopApi, ShowcaseOffer, ShowcaseView } from "../../state/shop-api";
import { track } from "../../state/shell";
import { loadWallet } from "../../state/wallet-api";
import { itemLabel, slotIcon, statName, statValue, toneOf } from "./arsenal-parts";
import { formatCountdown, msUntilReset } from "./schedule";
import { showcaseRefusal, type Notice } from "./shop-texts";

/**
 * Витрина снаряжения (docs/35-stage4-plan.md §3.6, Р11; WP10): конкретные
 * предметы суток за самоцветы. Свойства и мощь видны до покупки — их считает
 * сервер, а купить можно ровно показанное. Обновить витрину нельзя: новые
 * предметы приходят с новыми сутками, и отсчёт до них — тут же.
 *
 * Покупка — за самоцветы, поэтому с подтверждением: случайное касание не
 * должно съедать суточный запас.
 */

type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; view: ShowcaseView };

export function ShowcaseSection(props: { api: ShopApi; appearFrom: number; onNeedGems?: () => void }): ReactNode {
  const { api } = props;
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [asking, setAsking] = useState<ShowcaseOffer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [noGems, setNoGems] = useState(false);

  const load = async (): Promise<void> => {
    const response = await api.showcase();
    setState(response.ok ? { status: "ready", view: response.data } : { status: "failed" });
  };

  useEffect(() => {
    void load();
  }, []);

  const buy = async (offer: ShowcaseOffer): Promise<void> => {
    setAsking(null);
    if (busy !== null) return;
    setBusy(offer.offerId);
    setNotice(null);
    setNoGems(false);
    const response = await api.buyShowcase(offer.offerId);
    setBusy(null);
    if (!response.ok) {
      const refusal = showcaseRefusal(response.code);
      setNotice({ tone: "error", text: refusal.text });
      setNoGems(response.code === "insufficient_funds");
      if (refusal.reload) void load();
      return;
    }
    setState({ status: "ready", view: response.data.view });
    setNotice({ tone: "success", text: t("showcase.got", { item: itemLabel(offer) }) });
    track("showcase_bought", { slot: offer.slot, rarity: offer.rarity, level: offer.level, gems: offer.gems });
    void loadWallet();
  };

  if (state.status === "loading") return null;

  return (
    <section className="grid gap-2">
      <SectionTitle>{t("shop.section.showcase")}</SectionTitle>
      <p className="text-xs text-text-muted">{t("showcase.text")}</p>
      {state.status === "failed" ? <ErrorState text={t("showcase.loadFailed")} onRetry={() => void load()} /> : null}
      {state.status === "ready" ? (
        <>
          <RefreshLine />
          {notice === null ? null : (
            <p role="status" className={`text-sm font-semibold ${notice.tone === "success" ? "text-success" : "text-danger"}`}>
              {notice.text}
            </p>
          )}
          {/* Не хватило самоцветов — дорога к ним в одно касание, а не «ищите сами». */}
          {noGems && props.onNeedGems !== undefined ? (
            <Button variant="secondary" onClick={props.onNeedGems}>
              <GemIcon size={18} />
              {t("showcase.toGems")}
            </Button>
          ) : null}
          {state.view.offers.map((offer, index) => (
            <OfferCard key={offer.offerId} offer={offer} index={props.appearFrom + index} busy={busy} onBuy={() => setAsking(offer)} />
          ))}
        </>
      ) : null}

      {asking === null ? null : (
        <Modal
          placement="bottom"
          title={t("showcase.confirm.title")}
          onDismiss={() => setAsking(null)}
          footer={
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => setAsking(null)}>
                {t("showcase.confirm.cancel")}
              </Button>
              <Button onClick={() => void buy(asking)}>{t("showcase.confirm.ok")}</Button>
            </div>
          }
        >
          <p className="text-sm text-text-muted">{t("showcase.confirm.text", { item: itemLabel(asking), gems: formatNumber(asking.gems), n: asking.gems })}</p>
        </Modal>
      )}
    </section>
  );
}

function RefreshLine(): ReactNode {
  // Время считается при открытии, без тикающего таймера: минутная точность
  // не стоит перерисовки экрана раз в секунду.
  const [refreshIn] = useState(() => msUntilReset(Date.now(), "daily"));
  return (
    <p className="text-xs text-text-muted">{t("showcase.refresh", { time: formatCountdown(refreshIn) })}</p>
  );
}

function OfferCard(props: { offer: ShowcaseOffer; index: number; busy: string | null; onBuy: () => void }): ReactNode {
  const { offer } = props;
  const tone = toneOf(offer.rarity);
  return (
    <Card appearIndex={props.index} disabled={offer.sold}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className={`inline-flex size-12 shrink-0 items-center justify-center rounded-lg ring-2 ${tone.tile}`}>
          {slotIcon(offer.slot, 24)}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`font-display text-sm font-bold ${tone.text}`}>{itemLabel(offer)}</p>
          <p className="text-xs text-text-muted">{t("showcase.power", { power: formatNumber(offer.power) })}</p>
          {/* Свойства — целиком и до покупки: случайного за самоцветы в игре нет (Р11). */}
          <ul className="mt-1.5 grid gap-0.5 text-sm text-text">
            {[offer.main, ...offer.extras].map((stat, index) => (
              <li key={`${stat.stat}-${String(index)}`} className={index === 0 ? "font-semibold" : undefined}>
                {statName(stat.stat)} <span className="tabular-nums">{statValue(stat.stat, stat.value)}</span>
              </li>
            ))}
          </ul>
        </div>
        {offer.sold ? (
          <Badge tone="muted">
            <Check size={12} aria-hidden="true" />
            {t("showcase.sold")}
          </Badge>
        ) : null}
      </div>

      {offer.sold ? null : (
        <div className="mt-3">
          <Button
            block
            variant="secondary"
            disabled={props.busy !== null}
            loading={props.busy === offer.offerId}
            ariaLabel={t("showcase.buy", { gems: formatNumber(offer.gems), n: offer.gems })}
            onClick={props.onBuy}
          >
            <GemIcon size={18} />
            <span className="tabular-nums">{formatNumber(offer.gems)}</span>
          </Button>
        </div>
      )}
    </Card>
  );
}
