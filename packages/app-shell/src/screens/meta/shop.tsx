import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Gift } from "lucide-react";
import { Button, ContentColumn, ErrorState, InfoNotice, ListGroup, ListItem, Modal, PageTitle, Screen, SectionTitle, SegmentedControl, staggerStyle } from "../../design-system/components";
import { GemIcon } from "../../design-system/components/CurrencyIcons";
import { formatNumber, t } from "../../i18n";
import { openExternalLink } from "../../state/external-link";
import { useNavigation } from "../../state/navigation";
import "../../i18n/restrictions";
import { loadRestrictions, RESTRICTED_CODE, recheckRestriction, useRestricted } from "../../state/restrictions";
import { createShopApi, shopAvailable, type ShopItem, type ShopView, type VipView } from "../../state/shop-api";
import { buy, type BuyRequest } from "../../state/shop-purchase";
import { track, useShell } from "../../state/shell";
import { rewardFeedback, uiFeedback } from "../../state/ui-feedback";
import { loadWallet } from "../../state/wallet-api";
import { RestrictedPlaque } from "./restricted-plaque";
import { ShopBanners } from "./shop-banners";
import { dateOf, GemPackTile, ItemCard, TributePlaque, VipCard } from "./shop-parts";
import { gemsOf } from "./shop-look";
import { ShowcaseSection } from "./shop-showcase";
import { useClock } from "./schedule";
import { itemName, noticeOf, shopBanners, shownPrice, tributeOf, vipWaiting, type Notice, type ShopBanner, type ShopTab } from "./shop-texts";

/**
 * Магазин: VIP, витрина снаряжения за самоцветы и наборы за звёзды
 * (docs/35-stage4-plan.md §3.6, WP10; docs/27-design-system-and-app-shell.md §6).
 * Наверху — полоса баннеров с главным для этого игрока, под ней три вкладки:
 * «Для вас» (подобранное сервером, VIP и наборы), «Самоцветы» плиткой с
 * выгодой и «Снаряжение» — витрина суток.
 *
 * Что продаётся и почём, решает сервер: экран рисует витрину как пришла, и
 * товар, которого клиент ещё не знает, — тоже, по составу. У каждого набора
 * состав виден до оплаты целиком: случайного содержимого за деньги в игре нет
 * (Р11). Купленным товар считается, когда сервер сказал, что он на счету, —
 * не окно оплаты.
 */

// Экран промокода — в чанке магазина (`app/lazy-screens.tsx`).
export { PromoCodeScreen } from "./promo-code";

type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; shop: ShopView; vip: VipView | null };

const api = createShopApi();

/**
 * Покупки за звёзды закрыты ограничением (docs/35-stage4-plan.md, T-0024): ставится само после
 * возврата звёзд через Telegram. Кнопки покупки гаснут заранее, над витриной — плашка с причиной.
 * Остальное в магазине — забрать самоцветы дня, отменить продление, промокод — работает.
 */
const PURCHASES_RESTRICTION = ["purchases"];

/** «Занято», когда занимать нечем: гасит кнопки покупки, не крутя спиннер ни на одной из них. */
const CLOSED_KEY = "purchases:closed";

/** Баннеры, которые не покупка: переход к снаряжению и ссылка Tribute закрытие не гасит. */
const OPEN_BANNERS: readonly ShopBanner["kind"][] = ["gear", "tribute"];

/**
 * Часы экрана — только пока на витрине акция: её отсчёт идёт, а кончившаяся
 * на глазах показывает цену каталога, по которой сервер и выставит счёт.
 * Отсчёт акции — без секунд, чаще минуты перерисовывать незачем.
 */
const CLOCK_STEP_MS = 60_000;

export function ShopScreen(): ReactNode {
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [tab, setTab] = useState<ShopTab>("featured");
  const purchasesClosed = useRestricted(PURCHASES_RESTRICTION);

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
    // Закрытие покупок известно до первого нажатия, а не после отказа сервера.
    void loadRestrictions();
  }, []);

  const ready = state.status === "ready" ? state : null;
  const now = useClock(ready?.shop.items.some((item) => item.promo !== undefined && item.promo !== null) === true, CLOCK_STEP_MS);
  // Кнопки покупки видят «занято», пока покупки закрыты; остальным кнопкам магазина закрытие не мешает.
  const buyBusy = busy ?? (purchasesClosed ? CLOSED_KEY : null);

  /** Покупка набора или VIP: одна за раз — второе окно оплаты поверх первого только запутает. */
  const purchase = async (key: string, name: string, request: BuyRequest): Promise<void> => {
    if (busy !== null || purchasesClosed) return;
    setBusy(key);
    setNotice(null);
    const outcome = await buy(request, {
      api,
      openInvoice: useShell.getState().adapter.openInvoice,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    });
    setBusy(null);
    if (outcome.kind === "refused" && outcome.code === RESTRICTED_CODE) {
      // Закрыто ограничением — не сбой: список перечитывается, и плашка встаёт на место ошибки.
      if ((await recheckRestriction(PURCHASES_RESTRICTION)) === "lifted") setNotice({ tone: "error", text: t("restricted.lifted") });
      return;
    }
    setNotice(noticeOf(outcome, name));
    if (outcome.kind === "done") {
      // Звук покупки — когда сервер её подтвердил, а не на нажатии: окно
      // оплаты могли закрыть, и звон за несостоявшуюся покупку был бы враньём.
      uiFeedback("purchase");
      void loadWallet();
    }
    // Витрина после покупки другая: разовый куплен, VIP идёт. После отказа —
    // тоже: сервер мог отказать, потому что клиент видел устаревшее.
    if (outcome.kind !== "cancelled") void load(true);
  };

  const buyItem = (item: ShopItem, view: ShopView): void => {
    const price = shownPrice(item, Date.now());
    if (price.stars === null) return;
    const name = itemName(item);
    void purchase(item.sku, name, {
      product: "shop_item",
      sku: item.sku,
      priceStars: price.stars,
      chargedStars: item.chargedStars ?? price.stars,
      mode: view.mode ?? "live",
      ...(price.promo === null ? {} : { promoPct: price.promo.percent }),
      ...(item.badge === "hit" || item.badge === "choice" || item.badge === "best" ? { badge: item.badge } : {}),
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
      rewardFeedback("gems");
      setNotice({ tone: "success", text: t("vip.daily.got", { gems: formatNumber(response.data.gems), n: response.data.gems }) });
      void loadWallet();
    }
  };

  const onBanner = (banner: ShopBanner, position: number): void => {
    if (ready === null) return;
    track("shop_banner_clicked", { banner: banner.kind, place: "carousel", position });
    switch (banner.kind) {
      case "promo":
        buyItem(banner.item, ready.shop);
        return;
      case "vip":
        if (ready.vip !== null) buyVip(ready.vip);
        return;
      case "starter":
      case "recommended":
        buyItem(banner.item, ready.shop);
        return;
      case "gear":
        setTab("gear");
        return;
      case "tribute":
        openExternalLink(banner.url);
        return;
    }
  };

  const openTribute = (url: string): void => {
    track("shop_banner_clicked", { banner: "tribute", place: "gems", position: 0 });
    openExternalLink(url);
  };

  const packSizes = ready === null ? [] : gemPacks(ready.shop).map(gemsOf);

  const vipCard =
    ready?.vip === null || ready?.vip === undefined ? null : (
      <VipCard
        // Кнопку заказа гасит `canOrder`: забрать самоцветы дня и отменить продление при закрытых покупках можно.
        vip={purchasesClosed ? { ...ready.vip, canOrder: false } : ready.vip}
        busy={busy}
        onOrder={buyVip}
        onCancel={() => setConfirmCancel(true)}
        onResume={() => void vipAction("vip:resume", () => api.resumeVip(), t("vip.resume.failed"))}
        onClaim={() => void claimDaily()}
      />
    );

  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("shop.title")}</PageTitle>
        {!shopAvailable() ? <InfoNotice text={t("shop.guest")} /> : null}
        {state.status === "loading" && shopAvailable() ? <ShopSkeleton /> : null}
        {state.status === "failed" ? <ErrorState text={t("shop.failed")} onRetry={() => void load()} /> : null}

        {ready === null ? null : (
          <div className="mt-2 grid grid-cols-1 gap-4 pb-4">
            {!ready.shop.payable ? <InfoNotice text={t("shop.unpayable")} /> : null}
            {ready.shop.mode === "test" ? <InfoNotice text={t("shop.test", { charged: testCharge(ready.shop) })} /> : null}

            {purchasesClosed ? <RestrictedPlaque kinds={PURCHASES_RESTRICTION} /> : null}

            <ShopBanners banners={shopBanners(ready.shop, ready.vip, now).filter((banner) => !purchasesClosed || OPEN_BANNERS.includes(banner.kind))} busy={busy} now={now} onAction={onBanner} />

            <SegmentedControl track="tabs"
              label={t("shop.tabs")}
              activeId={tab}
              onSelect={(id) => setTab(id as ShopTab)}
              items={[
                { id: "featured", label: t("shop.tab.featured"), badge: vipWaiting(ready.vip) },
                { id: "gems", label: t("shop.tab.gems") },
                { id: "gear", label: t("shop.tab.gear") },
              ]}
            />

            {notice === null ? null : (
              <p role="status" className={`text-center text-sm font-semibold ${notice.tone === "success" ? "text-success" : "text-danger"}`}>
                {notice.text}
              </p>
            )}

            {tab === "featured" ? (
              <Featured
                shop={ready.shop}
                vip={ready.vip}
                vipCard={vipCard}
                busy={buyBusy}
                now={now}
                onBuy={(item) => buyItem(item, ready.shop)}
                onAllGems={() => setTab("gems")}
              />
            ) : null}

            {tab === "gems" ? (
              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-2">
                  {gemPacks(ready.shop).map((item, index) => (
                    <GemPackTile key={item.sku} item={item} index={index + 1} busy={buyBusy} now={now} packs={packSizes} onBuy={() => buyItem(item, ready.shop)} />
                  ))}
                </div>
                {/* Под плитками: с плашкой сверху «Лучшая цена» уходила за прокрутку уже на 360 px. */}
                {tributeOf(ready.shop) === null ? null : <TributePlaque onOpen={() => openTribute(tributeOf(ready.shop) ?? "")} />}
              </div>
            ) : null}

            {/* Витрина живёт своей загрузкой: вкладку открыли — сервер отдаёт предметы суток. */}
            {tab === "gear" ? <ShowcaseSection api={api} appearFrom={0} onNeedGems={() => setTab("gems")} /> : null}

            {/* Промокод ищут там, где подарки, — в магазине; под вкладками, чтобы не спорить с покупками. */}
            <ListGroup>
              <ListItem icon={<Gift size={18} />} title={t("shop.promoCode.title")} hint={t("shop.promoCode.hint")} onClick={() => useNavigation.getState().push("promoCode")} />
            </ListGroup>
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
              <Button track="keep_vip" variant="secondary" onClick={() => setConfirmCancel(false)}>
                {t("vip.cancel.keep")}
              </Button>
              <Button track="cancel_vip"
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

/**
 * «Для вас»: подобранное сервером — первым, VIP — сразу за ним, а если его
 * самоцветы дня ждут забора, то первым: забрать важнее, чем купить. Дальше
 * остальные наборы и дорога к самоцветам.
 */
function Featured(props: {
  shop: ShopView;
  vip: VipView | null;
  vipCard: ReactNode;
  busy: string | null;
  now: number;
  onBuy: (item: ShopItem) => void;
  onAllGems: () => void;
}): ReactNode {
  const { shop } = props;
  const recommended = shop.items.find((item) => item.sku === shop.recommended && !item.owned);
  const offers = shop.items.filter((item) => item.kind !== "gems" && item.sku !== recommended?.sku);
  const vipFirst = vipWaiting(props.vip) > 0;
  return (
    <div className="grid gap-3">
      {vipFirst ? props.vipCard : null}
      {recommended === undefined ? null : (
        <ItemCard item={recommended} index={1} busy={props.busy} now={props.now} forYou onBuy={() => props.onBuy(recommended)} />
      )}
      {vipFirst ? null : props.vipCard}
      {offers.length === 0 ? null : (
        <section className="grid gap-2">
          <SectionTitle>{t("shop.section.offers")}</SectionTitle>
          {offers.map((item, index) => (
            <ItemCard key={item.sku} item={item} index={index + 2} busy={props.busy} now={props.now} onBuy={() => props.onBuy(item)} />
          ))}
        </section>
      )}
      {gemPacks(shop).length === 0 ? null : (
        <Button track="all_gems" variant="secondary" onClick={props.onAllGems}>
          <GemIcon size={18} />
          {t("shop.allGems")}
          <ChevronRight size={18} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

function gemPacks(shop: ShopView): ShopItem[] {
  return shop.items.filter((item) => item.kind === "gems");
}

/** Сколько спишет тестовая оплата — по первому товару с ценой: она одна на всё. */
function testCharge(shop: ShopView): number {
  return shop.items.find((item) => item.chargedStars !== undefined && item.chargedStars !== null)?.chargedStars ?? 1;
}

/**
 * Заглушки на время загрузки той же высоты, что баннер, вкладки и карточки:
 * экран не прыгает, когда приходит ответ.
 */
function ShopSkeleton(): ReactNode {
  return (
    <div className="mt-2 grid gap-4" aria-busy>
      {[160, 42, 150, 220].map((height, index) => (
        <div key={height} aria-hidden="true" className="surface-card animate-pulse rounded-lg" style={{ height, ...staggerStyle(index) }} />
      ))}
    </div>
  );
}
