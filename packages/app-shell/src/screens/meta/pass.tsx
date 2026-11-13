import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Lock } from "lucide-react";
import { Button, Card, EmptyState, ErrorState, ProgressBar } from "../../design-system/components";
import { CoinIcon, GemIcon } from "../../design-system/components/CurrencyIcons";
import { ShardIcon } from "../../design-system/components/ShardIcon";
import { formatNumber, t } from "../../i18n";
import "../../i18n/boosts";
import "../../i18n/tasks";
import { loadBadges } from "../../state/badges-api";
import { useNavigation } from "../../state/navigation";
import {
  claimAll,
  createPassApi,
  loadPass,
  passClaimFailureKey,
  usePass,
  PASS_ALREADY_CLAIMED,
  PASS_TIER_NOT_REACHED,
  PASS_VIP_REQUIRED,
  type PassLane,
  type PassReward,
  type PassSnapshot,
} from "../../state/pass-api";
import { track } from "../../state/shell";
import { rewardFeedback } from "../../state/ui-feedback";
import { loadWallet } from "../../state/wallet-api";
import { boostIcon } from "../boost-icons";
import { burstAt, RewardBurst, type Burst } from "../reward-burst";
import { ICON_RESOURCE } from "../reward-burst-rules";
import { useClock } from "./schedule";
import {
  cellLabel,
  cellState,
  claimableRewards,
  focusTier,
  gainText,
  lockedVipCount,
  passTitle,
  pointsToNext,
  rewardGlyph,
  type CellState,
  type RewardGlyph,
} from "./pass-rules";

/**
 * Батл-пасс — вкладка «Пасс» в «Заданиях» (docs/35-stage4-plan.md Р46,
 * tasks/T-0314, макет design/art/mockups/pass-v2.html): шапка со ступенью в
 * медальоне и очками до следующей, две ленты по 30 ступеней, VIP-лента под
 * стеклом, пока VIP нет.
 *
 * Ступень, очки и право на забор считает сервер. Экран только показывает, что
 * можно забрать, и просит; награду не рисует до ответа (деньги и награды —
 * без оптимистичного обновления).
 *
 * `PassBoard` — чистая раскладка по готовому ответу: её же показывает витрина
 * компонентов. `PassPanel` — то же с запросами, забором и откликом.
 */

const LANES: readonly PassLane[] = ["free", "vip"];

/** Размеры ячейки — токены `--pass-cell-w` и `--pass-cell-h`: их же держит замок VIP. */
const CELL_STYLE = { width: "var(--pass-cell-w)", height: "var(--pass-cell-h)" } satisfies CSSProperties;

export interface PassBoardProps {
  view: PassSnapshot;
  /** «сейчас», мс: срок месяца считается от него */
  now: number;
  /** ключ забираемой сейчас награды (`6:free`) или «всё на ленте» (`all:free`); пока он есть, кнопки не нажимаются */
  busy: string | null;
  /** отказ или итог забора — строка под лентами */
  notice: string | null;
  onClaim(tier: number, lane: PassLane): void;
  onClaimAll(lane: PassLane): void;
  onVip(): void;
}

export function PassBoard(props: PassBoardProps): ReactNode {
  const { view } = props;
  const progress = pointsToNext(view);
  const scroller = useRef<HTMLDivElement>(null);
  const vipLocked = !view.vip;

  // Открытие экрана — лента у текущей ступени. Только вбок и только внутри ленты:
  // `scrollIntoView` двигал бы и страницу.
  useEffect(() => {
    const element = scroller.current;
    const cell = element?.querySelector<HTMLElement>(`[data-pass-cell="${String(focusTier(view))}:free"]`);
    if (element === null || element === undefined || cell === null || cell === undefined) return;
    element.scrollLeft = Math.max(0, cell.offsetLeft - (element.clientWidth - cell.offsetWidth) / 2);
    // Один раз на открытие: после забора лента не должна уезжать из-под пальца.
  }, []);

  return (
    <div className="grid min-w-0 gap-3">
      <Card>
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
          <span
            aria-hidden="true"
            className="row-span-2 inline-flex size-16 items-center justify-center rounded-full bg-surface-sunken font-display text-3xl font-bold text-elite tabular-nums ring-[3px] ring-elite/75"
          >
            {view.tier}
          </span>
          <div className="min-w-0">
            <p className="truncate font-display text-base font-bold text-text">{passTitle(view, props.now)}</p>
            <p className="text-xs font-semibold text-text-muted">{t("pass.tierOf", { tier: view.tier, total: view.tiers.length })}</p>
          </div>
          <ProgressBar value={progress.into} max={progress.step} tone="xp" label={t("pass.tab")} />
        </div>
        <div className="mt-2 flex items-baseline justify-between gap-3 text-xs text-text-muted">
          {progress.atMax ? (
            <span className="font-semibold text-text">{t("pass.maxTier")}</span>
          ) : (
            <>
              <span className="tabular-nums">
                <b className="font-semibold text-text">{t("pass.points", { points: formatNumber(view.points), next: formatNumber((view.tier + 1) * progress.step) })}</b>
              </span>
              <span className="font-semibold text-text tabular-nums">{t("pass.remaining", { n: progress.remaining })}</span>
            </>
          )}
        </div>
      </Card>
      <p className="px-0.5 text-xs text-text-muted">{t("pass.hint")}</p>

      {/* Лента на обе строки — одна прокрутка: бесплатная и VIP листаются вместе. */}
      <div className="relative min-w-0">
        <div ref={scroller} className="relative overflow-x-auto pb-1 [scrollbar-width:none]">
          <div className="grid w-max gap-1.5">
            {LANES.map((lane) => (
              <LaneRow key={lane} lane={lane} {...props} />
            ))}
          </div>
        </div>
        {vipLocked ? <VipLock count={lockedVipCount(view)} onVip={props.onVip} /> : null}
      </div>

      {props.notice === null ? null : (
        <p role="status" aria-live="polite" className="text-xs font-semibold text-text-muted">
          {props.notice}
        </p>
      )}
    </div>
  );
}

function LaneRow(props: PassBoardProps & { lane: PassLane }): ReactNode {
  const { view, lane, busy } = props;
  const waiting = claimableRewards(view, lane).length;
  return (
    <div>
      {/* Подпись ленты стоит на месте, пока лента листается под ней. */}
      <div className="sticky left-0 mb-1.5 flex w-fit items-center gap-3">
        <span className={`font-display text-xs font-bold tracking-wide uppercase ${lane === "vip" ? "text-elite" : "text-text-muted"}`}>{t(`pass.lane.${lane}`)}</span>
        {waiting >= 2 ? (
          <span data-pass-all={lane}>
            <Button track="claim_all" size="s" loading={busy === `all:${lane}`} disabled={busy !== null && busy !== `all:${lane}`} onClick={() => props.onClaimAll(lane)}>
              {t("pass.claimAll")}
            </Button>
          </span>
        ) : null}
      </div>
      <div role="list" aria-label={t("pass.laneLabel", { lane: t(`pass.lane.${lane}`) })} className="flex gap-2">
        {view.tiers.map((tier) => (
          <Cell key={tier.tier} view={view} tier={tier.tier} lane={lane} reward={tier[lane]} busy={busy} onClaim={() => props.onClaim(tier.tier, lane)} />
        ))}
      </div>
    </div>
  );
}

const CELL_CLASS: Record<CellState, string> = {
  claimed: "bg-surface opacity-60 ring-1 ring-border",
  ready: "bg-accent/10 ring-2 ring-accent shadow-[0_0_18px_-6px_var(--color-accent)]",
  locked: "bg-surface opacity-60 ring-1 ring-border",
  next: "bg-surface opacity-80 ring-2 ring-elite",
  future: "bg-surface opacity-45 ring-1 ring-border",
};

function Cell(props: { view: PassSnapshot; tier: number; lane: PassLane; reward: PassReward; busy: string | null; onClaim(): void }): ReactNode {
  const state = cellState(props.view, props.tier, props.lane);
  const glyph = rewardGlyph(props.reward);
  const key = `${String(props.tier)}:${props.lane}`;
  return (
    <div
      role="listitem"
      data-pass-cell={key}
      data-state={state}
      aria-label={cellLabel(props.tier, props.lane, props.reward, state)}
      style={CELL_STYLE}
      className={`relative flex shrink-0 flex-col items-center rounded-md px-1 pt-1.5 pb-2 text-center ${CELL_CLASS[state]}`}
    >
      <span aria-hidden="true" className="font-display text-xs font-bold text-text-muted tabular-nums">
        {props.tier}
      </span>
      <span aria-hidden="true" className="my-1 flex h-9 items-center justify-center">
        {glyph === null ? null : <GlyphIcon glyph={glyph} />}
      </span>
      <span aria-hidden="true" className="font-display text-sm font-bold text-text tabular-nums">
        {glyph === null ? "" : `${glyph.kind === "boost" || glyph.kind === "shard" ? "×" : ""}${formatNumber(glyph.amount)}${glyph.more ? "+" : ""}`}
      </span>
      {state === "claimed" ? <Check size={14} strokeWidth={3} aria-hidden="true" className="absolute top-1 right-1 text-success" /> : null}
      {state === "locked" ? <Lock size={12} aria-hidden="true" className="absolute top-1 right-1 text-text-muted" /> : null}
      {state === "ready" ? (
        <button
          type="button"
          data-pass-take={key}
          disabled={props.busy !== null}
          onClick={props.onClaim}
          className="mt-auto w-full rounded-sm bg-accent py-1 font-display text-[11px] font-bold text-on-accent uppercase after:absolute after:inset-0 after:content-[''] disabled:opacity-45"
        >
          {t("pass.claim")}
        </button>
      ) : null}
    </div>
  );
}

function GlyphIcon(props: { glyph: RewardGlyph }): ReactNode {
  const { glyph } = props;
  switch (glyph.kind) {
    case "coins":
      return <CoinIcon size={30} />;
    case "gems":
      return <GemIcon size={30} />;
    case "shard":
      return <ShardIcon rarity={glyph.rarity} size={30} />;
    case "boost": {
      const Icon = boostIcon(glyph.id);
      return <Icon size={30} aria-hidden="true" className="text-info" />;
    }
  }
}

/**
 * Замок поверх VIP-ленты: она видна целиком под стеклом, чтобы игрок видел, что
 * в ней лежит, а текст называет, сколько наград откроется, считая пройденные.
 * Высота — ровно ячейка: подпись ленты над ней остаётся читаемой.
 */
function VipLock(props: { count: number; onVip(): void }): ReactNode {
  return (
    <div
      data-pass-lock=""
      style={{ height: "var(--pass-cell-h)" }}
      className="surface-glass absolute inset-x-0 bottom-1 flex items-center gap-3 rounded-md px-3"
    >
      <Lock size={18} aria-hidden="true" className="shrink-0 text-elite" />
      <p className="min-w-0 flex-1 text-sm font-semibold text-text">{t("pass.vipLock", { n: props.count })}</p>
      <Button track="vip_open" size="s" ariaLabel={t("pass.vipOpenLabel")} onClick={props.onVip}>
        {t("pass.vipOpen")}
      </Button>
    </div>
  );
}

/** Награда в ответе после забора: цифра и значок вылетают из ячейки. */
function burstOf(credited: PassReward, target: Element | null): Burst | null {
  if ((credited.gems ?? 0) > 0) return burstAt(target, credited.gems ?? 0, "gem");
  if ((credited.coins ?? 0) > 0) return burstAt(target, credited.coins ?? 0, "coin");
  const shards = Object.entries(credited.shards ?? {})[0];
  return shards === undefined ? null : burstAt(target, shards[1], "shard", shards[0]);
}

/** Один звук на всё: что именно легло на счёт — главное по ценности. */
function feedbackOf(gain: { coins: number; gems: number; shards: number }): void {
  rewardFeedback(gain.gems > 0 ? ICON_RESOURCE.gem : gain.coins > 0 ? ICON_RESOURCE.coin : gain.shards > 0 ? ICON_RESOURCE.shard : null);
}

const api = createPassApi();

/** Вкладка «Пасс»: ответ сервера в сторе, забор по одной награде и «Забрать всё» на ленте. */
export function PassPanel(): ReactNode {
  const { view, failure, loading } = usePass();
  const now = useClock(true, 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [burst, setBurst] = useState<Burst | null>(null);

  useEffect(() => {
    void loadPass({ force: true });
  }, []);

  /** Пасс отстал от сервера — перечитать; забор могли сделать на другом устройстве. */
  const refresh = (): Promise<void> => loadPass({ force: true });

  const claim = async (tier: number, lane: PassLane): Promise<void> => {
    if (busy !== null) return;
    setBusy(`${String(tier)}:${lane}`);
    setNotice(null);
    const response = await api.claim(tier, lane);
    setBusy(null);
    if (!response.ok) {
      setNotice(t(passClaimFailureKey(response.code)));
      if (response.code === PASS_TIER_NOT_REACHED || response.code === PASS_ALREADY_CLAIMED || response.code === PASS_VIP_REQUIRED) void refresh();
      return;
    }
    track("pass_reward_claimed", { tier, lane });
    const text = gainText({ coins: response.data.credited.coins ?? 0, gems: response.data.credited.gems ?? 0, shards: Object.values(response.data.credited.shards ?? {}).reduce((sum, amount) => sum + amount, 0), boosts: response.data.credited.boost?.count ?? 0 });
    setNotice(text === "" ? null : t("pass.got", { what: text }));
    const credited = response.data.credited;
    feedbackOf({ coins: credited.coins ?? 0, gems: credited.gems ?? 0, shards: Object.keys(credited.shards ?? {}).length });
    setBurst(burstOf(credited, document.querySelector(`[data-pass-cell="${String(tier)}:${lane}"]`)));
    void loadWallet();
    void loadBadges();
    void refresh();
  };

  const takeAll = async (lane: PassLane): Promise<void> => {
    if (busy !== null || view === null) return;
    setBusy(`all:${lane}`);
    setNotice(null);
    const result = await claimAll(api, claimableRewards(view, lane));
    setBusy(null);
    for (const target of result.claimed) track("pass_reward_claimed", { tier: target.tier, lane: target.lane });
    if (result.claimed.length > 0) {
      // Один отклик счёта на всё: один звук, один выброс, один запрос кошелька (#460).
      feedbackOf(result.gain);
      const first = result.claimed[0];
      const origin = first === undefined ? null : document.querySelector(`[data-pass-cell="${String(first.tier)}:${first.lane}"]`);
      const main = result.gain.gems > 0 ? burstAt(origin, result.gain.gems, "gem") : result.gain.coins > 0 ? burstAt(origin, result.gain.coins, "coin") : null;
      setBurst(main);
      void loadWallet();
      void loadBadges();
    }
    const gained = gainText(result.gain);
    if (result.failure !== null) setNotice(t(passClaimFailureKey(result.failure.code)));
    else setNotice(gained === "" ? null : t("pass.got", { what: gained }));
    if (result.claimed.length > 0 || result.stale || result.failure !== null) void refresh();
  };

  if (view === null) {
    if (failure !== null) return <ErrorState text={t(failure === "offline" ? "pass.offline" : "pass.failed")} onRetry={() => void refresh()} />;
    return <p className="mt-4 text-sm text-text-muted">{t(loading || failure === null ? "pass.loading" : "pass.failed")}</p>;
  }
  if (view.tiers.length === 0) return <EmptyState icon={<Lock size={28} aria-hidden="true" />} text={t("pass.failed")} />;

  return (
    <>
      <PassBoard
        view={view}
        now={now}
        busy={busy}
        notice={notice}
        onClaim={(tier, lane) => void claim(tier, lane)}
        onClaimAll={(lane) => void takeAll(lane)}
        onVip={() => useNavigation.getState().resetTo("shop")}
      />
      {burst === null ? null : <RewardBurst key={burst.key} burst={burst} onDone={() => setBurst(null)} />}
    </>
  );
}

/** Месяц с лентой по образцу экрана: монеты у бесплатной, самоцветы и осколки у VIP, подарок-буст на каждой пятой. */
function demoPass(patch: Partial<PassSnapshot>, claimed: { free: number; vip: number }): PassSnapshot {
  return {
    monthKey: "2026-11",
    endsAt: "2026-11-30T21:00:00.000Z",
    points: 750,
    tier: 7,
    pointsPerTier: 100,
    vip: false,
    tiers: Array.from({ length: 30 }, (_, index) => {
      const tier = index + 1;
      return {
        tier,
        free: tier % 5 === 0 ? { coins: 100 + index * 10, boost: { id: "fury", count: 1 } } : { coins: 100 + index * 10 },
        vip: tier % 3 === 0 ? { gems: 10 + index } : { shards: { rare: 2 + Math.floor(tier / 10) } },
        claimed: { free: tier <= claimed.free, vip: tier <= claimed.vip },
      };
    }),
    ...patch,
  };
}

/**
 * Все состояния вкладки на тестовых данных — для витрины компонентов
 * (docs/27-design-system-and-app-shell.md §9): новичок на нулевой ступени,
 * середина месяца без VIP, с VIP и незабранным, всё забрано.
 */
export function PassShowcase(): ReactNode {
  const now = Date.parse("2026-11-19T12:00:00.000Z");
  const states: { title: string; view: PassSnapshot }[] = [
    { title: "Новичок на нулевой ступени", view: demoPass({ points: 0, tier: 0 }, { free: 0, vip: 0 }) },
    { title: "Середина месяца, без VIP", view: demoPass({}, { free: 5, vip: 0 }) },
    { title: "С VIP, есть незабранное", view: demoPass({ vip: true }, { free: 5, vip: 3 }) },
    { title: "Всё забрано", view: demoPass({ vip: true, points: 3_000, tier: 30 }, { free: 30, vip: 30 }) },
  ];
  return (
    <div className="grid gap-6">
      {states.map((state) => (
        <section key={state.title} aria-label={state.title}>
          <p className="mb-2 text-xs font-semibold text-text-muted">{state.title}</p>
          <PassBoard view={state.view} now={now} busy={null} notice={null} onClaim={() => undefined} onClaimAll={() => undefined} onVip={() => undefined} />
        </section>
      ))}
    </div>
  );
}
