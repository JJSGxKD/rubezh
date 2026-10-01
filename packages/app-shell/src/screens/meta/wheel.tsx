import { useEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react";
import { Crown, Diamond, LoaderPinwheel, Tv } from "lucide-react";
import { Button, ContentColumn, ErrorState, InfoNotice, ListGroup, ListItem, Screen, SectionTitle } from "../../design-system/components";
import { CoinIcon } from "../../design-system/components/CurrencyIcons";
import { formatDecimal, formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/wheel";
import { loadBadges } from "../../state/badges-api";
import { useNavigation } from "../../state/navigation";
import { track } from "../../state/shell";
import { uiFeedback } from "../../state/ui-feedback";
import { loadWallet } from "../../state/wallet-api";
import { createAdsApi } from "../../state/ads-api";
import {
  WHEEL_AD_COOLDOWN,
  WHEEL_AD_NEEDS_VIDEO,
  WHEEL_SPENT,
  adSpinState,
  createWheelApi,
  spinWithPass,
  wheelAvailable,
  type WheelSector,
  type WheelSpin,
  type WheelView,
} from "../../state/wheel-api";
import { formatCountdown, msUntilReset } from "./schedule";
import { sectorCenterDeg, spinRotationDeg } from "./wheel-math";

/**
 * Колесо удачи (docs/07-monetization-and-ads.md §7, docs/35-stage4-plan.md
 * WP13): одна бесплатная крутка в московские сутки, за валюту — никогда.
 *
 * Сектор выбирает сервер: клиент сначала получает ответ и только потом
 * докручивает колесо до выпавшего сектора, поэтому крутка без сети не
 * проходит. Шансы — с сервера и на том же экране: игрок видит, на что крутит.
 * Крутка за рекламу придёт с роликами (WP12) — до них кнопка честно говорит
 * «скоро». У VIP ролика нет (§3.6): его крутка за рекламу идёт уже сейчас,
 * после кулдауна места.
 */

/** Полных оборотов за крутку, помимо докрутки до сектора. */
const SPIN_TURNS = 5;

/** Отказы, после которых экран перечитывается: он устарел, а не сломался. */
const STALE_NOTICES: Partial<Record<string, string>> = {
  [WHEEL_SPENT]: "wheel.spent",
  [WHEEL_AD_COOLDOWN]: "wheel.adCooldown",
  [WHEEL_AD_NEEDS_VIDEO]: "wheel.vipEnded",
};

type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; view: WheelView };
/** `asking` — ждём сервер, колесо стоит; `spinning` — сектор известен, колесо крутится. */
type Phase = "idle" | "asking" | "spinning";

const api = createWheelApi();
const ads = createAdsApi();

export function WheelScreen(): ReactNode {
  const navigation = useNavigation();
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [phase, setPhase] = useState<Phase>("idle");
  const [rotation, setRotation] = useState(0);
  const [won, setWon] = useState<WheelSpin | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef<WheelSpin | null>(null);
  const [source, setSource] = useState<"free" | "ad">("free");

  const load = async (): Promise<void> => {
    setState({ status: "loading" });
    const response = await api.view();
    setState(response.ok ? { status: "ready", view: response.data } : { status: "failed" });
  };

  useEffect(() => {
    if (wheelAvailable()) void load();
  }, []);

  const spin = async (kind: "free" | "ad"): Promise<void> => {
    if (state.status !== "ready" || phase !== "idle") return;
    if (kind === "free" ? !state.view.free : adSpinState(state.view, Date.now()).kind !== "ready") return;
    setPhase("asking");
    setWon(null);
    setNotice(null);
    setSource(kind);
    const response = kind === "free" ? await api.spin() : await spinWithPass(ads, api);
    if (!response.ok) {
      setPhase("idle");
      const stale = STALE_NOTICES[response.code ?? ""];
      if (stale === undefined) {
        setNotice(t("wheel.spinFailed"));
        return;
      }
      // Экран устарел: крутку уже крутили, место на кулдауне или VIP кончился.
      setNotice(t(stale));
      void load();
      void loadBadges();
      return;
    }
    pending.current = response.data;
    setState({ status: "ready", view: response.data.view });
    setPhase("spinning");
    setRotation((current) => spinRotationDeg(current, response.data.sector, response.data.view.sectors.length, SPIN_TURNS));
  };

  const onSpinEnd = (event: TransitionEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.propertyName !== "transform") return;
    const result = pending.current;
    setPhase("idle");
    if (result === null) return;
    setWon(result);
    uiFeedback("reward");
    track("wheel_spun", { source, sector: result.sector, reward: result.resource, amount: result.amount });
    void loadWallet();
    void loadBadges();
  };

  const ready = state.status === "ready" ? state.view : null;
  const adSpin = ready === null ? ({ kind: "soon" } as const) : adSpinState(ready, Date.now());

  return (
    <Screen
      title={t("wheel.title")}
      onBack={() => navigation.pop()}
      footer={
        wheelAvailable() ? (
          <div className="grid gap-2">
            <Button size="l" block glow={ready?.free === true && phase === "idle"} disabled={ready === null || (!ready.free && phase === "idle")} loading={phase !== "idle" && source === "free"} onClick={() => void spin("free")}>
              {ready !== null && !ready.free && phase === "idle" ? t("wheel.spin.next", { time: formatCountdown(msUntilReset(Date.now(), "daily")) }) : t("wheel.spin.free")}
            </Button>
            <Button variant="secondary" block disabled={adSpin.kind !== "ready" || (phase !== "idle" && source !== "ad")} loading={phase !== "idle" && source === "ad"} onClick={() => void spin("ad")}>
              {adSpin.kind === "soon" ? <Tv size={18} aria-hidden="true" /> : <Crown size={18} aria-hidden="true" />}
              {adSpin.kind === "soon" ? t("wheel.spin.ad") : adSpin.kind === "ready" ? t("wheel.spin.vip") : t("wheel.spin.vipNext", { time: formatCountdown(adSpin.untilMs - Date.now()) })}
            </Button>
          </div>
        ) : undefined
      }
    >
      <ContentColumn>
        <p className="mt-2 mb-3 text-center text-sm text-text-muted">{t("wheel.text")}</p>

        {!wheelAvailable() ? <InfoNotice text={t("wheel.guest")} /> : null}
        {state.status === "loading" && wheelAvailable() ? <p className="text-center text-sm text-text-muted">{t("wheel.loading")}</p> : null}
        {state.status === "failed" ? <ErrorState text={t("wheel.failed")} onRetry={() => void load()} /> : null}

        {ready === null ? null : (
          <>
            <div className="relative mx-auto mt-6 aspect-square w-full max-w-[300px] landscape:max-w-[220px]">
              {/* Круглая маска вокруг вращения: повёрнутый квадрат колеса по
                  диагонали шире себя, и без маски после крутки у экрана
                  появлялась горизонтальная прокрутка. */}
              <div className="absolute inset-0 overflow-hidden rounded-full">
                <div
                  onTransitionEnd={onSpinEnd}
                  className="size-full transition-transform duration-(--duration-spin) ease-spin"
                  style={{ transform: `rotate(${rotation}deg)` }}
                >
                  <WheelFace sectors={ready.sectors} />
                </div>
              </div>
              {/* Стрелка и ступица не вращаются: стрелка — точка отсчёта. */}
              <span aria-hidden="true" className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/3 text-accent">
                <svg viewBox="0 0 24 30" className="h-8 w-7 fill-current">
                  <path d="M2 2h20L12 28z" />
                </svg>
              </span>
              <span
                aria-hidden="true"
                className="surface-card absolute top-1/2 left-1/2 inline-flex size-14 -translate-1/2 items-center justify-center rounded-full text-accent"
              >
                <LoaderPinwheel size={26} />
              </span>
            </div>

            <div role="status" className="mt-4 min-h-14 text-center">
              {won === null ? null : (
                <div className="animate-pop-in">
                  <p className="font-display text-lg font-bold text-text">{t("wheel.result", { reward: sectorLabel(won) })}</p>
                  {won.credited < won.amount ? <p className="text-xs text-text-muted">{t("wheel.capped", { amount: formatNumber(won.credited) })}</p> : null}
                </div>
              )}
              {notice === null ? null : <p className="text-sm font-semibold text-text-muted">{notice}</p>}
            </div>

            <SectionTitle>{t("wheel.odds")}</SectionTitle>
            <ListGroup>
              {[...ready.sectors]
                .sort((left, right) => right.odds - left.odds)
                .map((sector) => (
                  <ListItem
                    key={`${sector.resource}-${String(sector.amount)}`}
                    icon={<span className={sectorTone(sector.resource)}><SectorIcon resource={sector.resource} size={18} /></span>}
                    title={sectorLabel(sector)}
                    value={t("wheel.percent", { value: formatDecimal(sector.odds * 100, 1) })}
                  />
                ))}
            </ListGroup>
          </>
        )}
      </ContentColumn>
    </Screen>
  );
}

/**
 * Вид награды различается и цветом, и формой значка — одним цветом он не
 * передаётся (docs/27-design-system-and-app-shell.md §4.4). Осколки — тоном
 * своей редкости, как в арсенале; незнакомое от сервера новее клиента —
 * нейтрально.
 */
const SECTOR_TONE: Record<string, string> = {
  coins: "text-accent",
  shard_common: "text-info",
  shard_uncommon: "text-success",
};

function sectorTone(resource: string): string {
  return SECTOR_TONE[resource] ?? "text-text-muted";
}

function SectorIcon(props: { resource: string; size: number }): ReactNode {
  return props.resource === "coins" ? <CoinIcon size={props.size} /> : <Diamond size={props.size} aria-hidden="true" />;
}

function sectorLabel(sector: Pick<WheelSector, "resource" | "amount">): string {
  const key = `wheel.reward.${sector.resource}`;
  return hasTranslation(key) ? t(key, { amount: formatNumber(sector.amount), n: sector.amount }) : formatNumber(sector.amount);
}

/** Радиус секторов в единицах viewBox; обод и огни — снаружи него. */
const R = 108;
const RIM_LIGHTS = 16;

/** Лицо колеса: сектора, значки наград и обод. Геометрия — в единицах viewBox. */
function WheelFace(props: { sectors: readonly WheelSector[] }): ReactNode {
  const count = props.sectors.length;

  return (
    <svg viewBox="-120 -120 240 240" className="size-full" aria-hidden="true">
      <circle r={118} className="fill-current text-surface-sunken" />
      {props.sectors.map((_, index) => (
        <path key={index} d={sectorPath(index, count)} className={`fill-current ${index % 2 === 0 ? "text-surface-raised" : "text-surface"}`} />
      ))}
      {/* Цветная дуга у обода — вид награды читается издалека, пока колесо крутится. */}
      {props.sectors.map((sector, index) => (
        <path
          key={index}
          d={arcPath(index, count, R - 4)}
          fill="none"
          strokeWidth={6}
          strokeOpacity={0.7}
          className={`stroke-current ${sectorTone(sector.resource)}`}
        />
      ))}
      {props.sectors.map((_, index) => {
        const [x, y] = polar(R, (index * 360) / count);
        return <line key={index} x2={x} y2={y} strokeWidth={1.5} className="stroke-current text-border-strong" />;
      })}
      {props.sectors.map((sector, index) => (
        <g key={index} transform={`rotate(${sectorCenterDeg(index, count)})`}>
          <svg x={-12} y={-R + 16} width={24} height={24} overflow="visible" className={sectorTone(sector.resource)}>
            <SectorIcon resource={sector.resource} size={24} />
          </svg>
          <text y={-R + 58} textAnchor="middle" className="fill-current font-display text-sm font-bold text-text">
            {formatNumber(sector.amount)}
          </text>
        </g>
      ))}
      <circle r={R + 5} fill="none" strokeWidth={6} className="stroke-current text-border-strong" />
      {Array.from({ length: RIM_LIGHTS }, (_, index) => {
        const [x, y] = polar(R + 5, (index * 360) / RIM_LIGHTS);
        return <circle key={index} cx={x} cy={y} r={2.2} className={`fill-current ${index % 2 === 0 ? "text-accent" : "text-accent-glow"}`} />;
      })}
    </svg>
  );
}

/** Точка на окружности: угол от верха по часовой стрелке, ось y вниз, как в SVG. */
function polar(radius: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [radius * Math.sin(rad), -radius * Math.cos(rad)];
}

function sectorPath(index: number, count: number): string {
  return `M0 0L${arcPath(index, count, R).slice(1)}Z`;
}

function arcPath(index: number, count: number, radius: number): string {
  const [x1, y1] = polar(radius, (index * 360) / count);
  const [x2, y2] = polar(radius, ((index + 1) * 360) / count);
  return `M${x1} ${y1}A${radius} ${radius} 0 0 1 ${x2} ${y2}`;
}
