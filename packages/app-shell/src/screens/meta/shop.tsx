import { useEffect, useState, type ReactNode } from "react";
import { Check, Crown, Sparkles, TrendingUp } from "lucide-react";
import { Badge, Button, Card, ContentColumn, ErrorState, InfoNotice, Modal, PageTitle, Screen, SectionTitle } from "../../design-system/components";
import { CoinIcon, GemIcon } from "../../design-system/components/CurrencyIcons";
import { ShardIcon, shardRarity } from "../../design-system/components/ShardIcon";
import { StarsIcon } from "../../design-system/components/StarsIcon";
import { formatDecimal, formatNumber, hasTranslation, t } from "../../i18n";
import { createShopApi, shopAvailable, type ShopItem, type ShopView, type VipView } from "../../state/shop-api";
import { buy, type BuyRequest } from "../../state/shop-purchase";
import { useShell } from "../../state/shell";
import { loadWallet } from "../../state/wallet-api";
import { formatCountdown, msUntilReset } from "./schedule";
import { ShowcaseSection } from "./shop-showcase";
import { itemName, noticeOf, resourceLabel, type Notice } from "./shop-texts";

/**
 * Магазин: VIP, витрина снаряжения за самоцветы и наборы за звёзды
 * (docs/35-stage4-plan.md §3.6, WP10; docs/27-design-system-and-app-shell.md §6).
 *
 * Что продаётся и почём, решает сервер: экран рисует витрину как пришла, и
 * товар, которого клиент ещё не знает, — тоже, по составу. У каждого набора
 * состав виден до оплаты целиком: случайного содержимого за деньги в игре нет
 * (Р11). Купленным товар считается, когда сервер сказал, что он на счету, —
 * не окно оплаты.
 */

type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; shop: ShopView; vip: VipView | null };

const api = createShopApi();

const DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

export function ShopScreen(): ReactNode {
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const load = async (quiet = false): Promise<void> => {
    if (!quiet) setState({ status: "loading" });
    const [shop, vip] = await Promise.all([api.view(), api.vip()]);
    if (!shop.ok) {
      if (!quiet) setState({ status: "failed" });
      return;
    }
    setState({ status: "ready", shop: shop.data, vip: vip.ok ? vip.data : null });
  };

  useEffect(() => {
    if (shopAvailable()) void load();
  }, []);

  const ready = state.status === "ready" ? state : null;

  /** Покупка набора или VIP: одна за раз — второе окно оплаты поверх первого только запутает. */
  const purchase = async (key: string, name: string, request: BuyRequest): Promise<void> => {
    if (busy !== null) return;
    setBusy(key);
    setNotice(null);
    const outcome = await buy(request, {
      api,
      openInvoice: useShell.getState().adapter.openInvoice,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    });
    setBusy(null);
    setNotice(noticeOf(outcome, name));
    if (outcome.kind === "done") void loadWallet();
    // Витрина после покупки другая: разовый куплен, VIP идёт. После отказа —
    // тоже: сервер мог отказать, потому что клиент видел устаревшее.
    if (outcome.kind !== "cancelled") void load(true);
  };

  const buyItem = (item: ShopItem, view: ShopView): void => {
    if (item.stars === null) return;
    const name = itemName(item);
    void purchase(item.sku, name, {
      product: "shop_item",
      sku: item.sku,
      priceStars: item.stars,
      chargedStars: item.chargedStars ?? item.stars,
      mode: view.mode ?? "live",
      order: () => api.order(item.sku),
    });
  };

  const buyVip = (vip: VipView): void => {
    if (vip.stars === null) return;
    void purchase("vip", t("vip.title"), {
      product: "vip",
      sku: vip.sku ?? "vip",
      priceStars: vip.stars,
      chargedStars: vip.chargedStars ?? vip.stars,
      mode: vip.mode ?? "live",
      order: () => api.orderVip(),
    });
  };

  /** Отмена, возврат продления и самоцветы дня — ответ сервера и есть новое состояние VIP. */
  const vipAction = async (key: string, call: () => Promise<{ ok: true; data: VipView } | { ok: false }>, failed: string): Promise<void> => {
    if (busy !== null || ready === null) return;
    setBusy(key);
    setNotice(null);
    const response = await call();
    setBusy(null);
    if (!response.ok) {
      setNotice({ tone: "error", text: failed });
      return;
    }
    setState({ ...ready, vip: response.data });
  };

  const claimDaily = async (): Promise<void> => {
    if (busy !== null || ready === null) return;
    setBusy("vip:daily");
    setNotice(null);
    const response = await api.claimVipDaily();
    setBusy(null);
    if (!response.ok) {
      setNotice({ tone: "error", text: t("vip.daily.failed") });
      return;
    }
    setState({ ...ready, vip: response.data.view });
    if (response.data.claimed) {
      setNotice({ tone: "success", text: t("vip.daily.got", { gems: formatNumber(response.data.gems), n: response.data.gems }) });
      void loadWallet();
    }
  };

  const offers = ready === null ? [] : ready.shop.items.filter((item) => item.kind !== "gems");
  const gems = ready === null ? [] : ready.shop.items.filter((item) => item.kind === "gems");

  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("shop.title")}</PageTitle>
        {!shopAvailable() ? <InfoNotice text={t("shop.guest")} /> : null}
        {state.status === "loading" && shopAvailable() ? <p className="mt-2 text-sm text-text-muted">{t("shop.loading")}</p> : null}
        {state.status === "failed" ? <ErrorState text={t("shop.failed")} onRetry={() => void load()} /> : null}

        {ready === null ? null : (
          <div className="mt-2 grid gap-4 pb-4">
            {!ready.shop.payable ? <InfoNotice text={t("shop.unpayable")} /> : null}
            {ready.shop.mode === "test" ? <InfoNotice text={t("shop.test", { charged: testCharge(ready.shop) })} /> : null}
            {notice === null ? null : (
              <p role="status" className={`text-center text-sm font-semibold ${notice.tone === "success" ? "text-success" : "text-danger"}`}>
                {notice.text}
              </p>
            )}

            {ready.vip === null ? null : (
              <VipCard
                vip={ready.vip}
                busy={busy}
                onOrder={buyVip}
                onCancel={() => setConfirmCancel(true)}
                onResume={() => void vipAction("vip:resume", () => api.resumeVip(), t("vip.resume.failed"))}
                onClaim={() => void claimDaily()}
              />
            )}

            <ShowcaseSection api={api} appearFrom={1} />

            {offers.length === 0 ? null : (
              <section className="grid gap-2">
                <SectionTitle>{t("shop.section.offers")}</SectionTitle>
                {offers.map((item, index) => (
                  <ItemCard key={item.sku} item={item} index={index} busy={busy} onBuy={() => buyItem(item, ready.shop)} />
                ))}
              </section>
            )}

            {gems.length === 0 ? null : (
              <section className="grid gap-2">
                <SectionTitle>{t("shop.section.gems")}</SectionTitle>
                {gems.map((item, index) => (
                  <ItemCard key={item.sku} item={item} index={offers.length + index} busy={busy} onBuy={() => buyItem(item, ready.shop)} />
                ))}
              </section>
            )}
          </div>
        )}
      </ContentColumn>

      {confirmCancel && ready?.vip !== null && ready?.vip !== undefined ? (
        <Modal
          placement="bottom"
          title={t("vip.cancel.title")}
          onDismiss={() => setConfirmCancel(false)}
          footer={
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => setConfirmCancel(false)}>
                {t("vip.cancel.keep")}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmCancel(false);
                  void vipAction("vip:cancel", () => api.cancelVip(), t("vip.cancel.failed"));
                }}
              >
                {t("vip.cancel")}
              </Button>
            </div>
          }
        >
          <p className="text-sm text-text-muted">{t("vip.cancel.text", { date: dateOf(ready.vip.until) })}</p>
        </Modal>
      ) : null}
    </Screen>
  );
}

function VipCard(props: {
  vip: VipView;
  busy: string | null;
  onOrder: (vip: VipView) => void;
  onCancel: () => void;
  onResume: () => void;
  onClaim: () => void;
}): ReactNode {
  const { vip, busy } = props;
  const stars = vip.stars;
  return (
    <Card selected={vip.active} stripe="accent" appearIndex={0}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
          <Crown size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-bold text-text">{t("vip.title")}</p>
          <p className="text-sm text-text-muted">{statusLine(vip) ?? t("vip.pitch", { days: vip.periodDays })}</p>
        </div>
      </div>

      <ul className="mt-3 grid gap-1.5 text-sm text-text">
        <li className="flex items-center gap-2">
          <GemIcon size={16} />
          {t("vip.perk.daily", { gems: formatNumber(vip.daily.gems), n: vip.daily.gems })}
        </li>
        {vip.rewardMul !== undefined && vip.rewardMul > 1 ? (
          <li className="flex items-center gap-2">
            <TrendingUp size={16} aria-hidden="true" className="text-accent" />
            {t("vip.perk.rewards", { mul: formatDecimal(vip.rewardMul) })}
          </li>
        ) : null}
        <li className="flex items-center gap-2">
          <Sparkles size={16} aria-hidden="true" className="text-accent" />
          {t("vip.perk.noAds")}
        </li>
      </ul>

      <div className="mt-4 grid gap-2">
        {vip.active ? (
          <Button
            block
            variant={vip.daily.claimed ? "secondary" : "primary"}
            disabled={vip.daily.claimed || busy !== null}
            loading={busy === "vip:daily"}
            onClick={props.onClaim}
          >
            {vip.daily.claimed
              ? t("vip.daily.next", { time: formatCountdown(msUntilReset(Date.now(), "daily")) })
              : t("vip.daily.claim", { gems: formatNumber(vip.daily.gems), n: vip.daily.gems })}
          </Button>
        ) : null}

        {/* Отменённое нами продление возвращается бесплатно — вторая подписка тут лишняя. */}
        {vip.canOrder && !vip.canResume && stars !== null ? (
          <Button
            block
            variant="stars"
            disabled={busy !== null}
            loading={busy === "vip"}
            ariaLabel={t(vip.active ? "vip.renew" : "vip.order", { stars, n: stars })}
            onClick={() => props.onOrder(vip)}
          >
            <StarsIcon size={18} />
            <span className="tabular-nums">{t("vip.price", { stars, days: vip.periodDays })}</span>
          </Button>
        ) : null}

        {vip.active && vip.renewal === "on" ? (
          <Button variant="ghost" disabled={busy !== null} loading={busy === "vip:cancel"} onClick={props.onCancel}>
            {t("vip.cancel")}
          </Button>
        ) : null}
        {vip.canResume ? (
          <Button variant="secondary" disabled={busy !== null} loading={busy === "vip:resume"} onClick={props.onResume}>
            {t("vip.resume")}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function ItemCard(props: { item: ShopItem; index: number; busy: string | null; onBuy: () => void }): ReactNode {
  const { item } = props;
  const name = itemName(item);
  const textKey = `shop.sku.${item.sku}.text`;
  const stars = item.stars;
  return (
    <Card appearIndex={props.index + 1} stripe={item.kind === "starter" ? "accent" : undefined} disabled={item.owned}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-base font-bold text-text">{name}</p>
          {hasTranslation(textKey) ? <p className="text-xs text-text-muted">{t(textKey)}</p> : null}
        </div>
        {item.once && !item.owned ? <Badge tone="accent">{t("shop.once")}</Badge> : null}
      </div>

      {/* Состав — целиком и до оплаты: случайного за деньги в игре нет (Р11). */}
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-text">
        {item.contents.map((part) => (
          <li key={part.resource} className="flex items-center gap-1.5">
            <ResourceIcon resource={part.resource} />
            {resourceLabel(part.resource, part.amount)}
          </li>
        ))}
      </ul>

      {item.owned ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-success">
          <Check size={16} aria-hidden="true" />
          {t("shop.owned")}
        </p>
      ) : stars === null ? null : (
        <div className="mt-3">
          <Button
            block
            variant="stars"
            disabled={props.busy !== null}
            loading={props.busy === item.sku}
            ariaLabel={t("shop.buy", { name, stars, n: stars })}
            onClick={props.onBuy}
          >
            <StarsIcon size={18} />
            <span className="tabular-nums">{formatNumber(stars)}</span>
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Вид ресурса различается и цветом, и формой значка — одним цветом он не
 * передаётся (docs/27-design-system-and-app-shell.md §4.4). Осколки — общим
 * значком цвета своей редкости, как в арсенале и на колесе; незнакомое —
 * нейтральным осколком.
 */
function ResourceIcon(props: { resource: string }): ReactNode {
  if (props.resource === "coins") return <CoinIcon size={16} />;
  if (props.resource === "gems") return <GemIcon size={16} />;
  return <ShardIcon rarity={shardRarity(props.resource) ?? ""} size={16} />;
}

function statusLine(vip: VipView): string | null {
  if (vip.until === null) return null;
  const date = dateOf(vip.until);
  if (!vip.active) return t("vip.ended", { date });
  if (vip.renewal === "on") return t("vip.until.on", { date });
  return t(vip.renewal === "failed" ? "vip.until.failed" : "vip.until.cancelled", { date });
}

function dateOf(iso: string | null): string {
  return iso === null ? "—" : DATE.format(new Date(iso));
}

/** Сколько спишет тестовая оплата — по первому товару с ценой: она одна на всё. */
function testCharge(shop: ShopView): number {
  return shop.items.find((item) => item.chargedStars !== undefined && item.chargedStars !== null)?.chargedStars ?? 1;
}
