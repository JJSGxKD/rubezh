import { useEffect, useState, type ReactNode } from "react";
import { CalendarCheck, Check } from "lucide-react";
import { Button, ContentColumn, ErrorState, IconEmblem, InfoNotice, Screen, staggerStyle } from "../../design-system/components";
import { CoinIcon } from "../../design-system/components/CurrencyIcons";
import { ShardIcon } from "../../design-system/components/ShardIcon";
import { formatDecimal, formatNumber, t } from "../../i18n";
import "../../i18n/daily";
import { loadBadges } from "../../state/badges-api";
import { createDailyApi, dailyAvailable, dayOfWeek, type DailyDay, type DailyView } from "../../state/daily-api";
import { useNavigation } from "../../state/navigation";
import { track } from "../../state/shell";
import { loadWallet } from "../../state/wallet-api";
import { formatCountdown, msUntilReset } from "./schedule";

/**
 * Награда дня: неделя из семи дней, седьмой крупнее
 * (docs/27-design-system-and-app-shell.md §6, docs/35-stage4-plan.md Р45).
 * Какой день сегодня и что забрано, решает сервер по московским суткам.
 * Пропуск дня прогресс не сбрасывает, закрытая неделя поднимает награды — об
 * этом экран говорит прямо, иначе пропуск выглядел бы как потеря.
 */

type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; view: DailyView };

const api = createDailyApi();

export function DailyScreen(): ReactNode {
  const navigation = useNavigation();
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [claiming, setClaiming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setState({ status: "loading" });
    const response = await api.view();
    setState(response.ok ? { status: "ready", view: response.data } : { status: "failed" });
  };

  useEffect(() => {
    if (dailyAvailable()) void load();
  }, []);

  const claim = async (): Promise<void> => {
    if (state.status !== "ready") return;
    setClaiming(true);
    const response = await api.claim();
    setClaiming(false);
    if (!response.ok) {
      setNotice(t("daily.claimFailed"));
      return;
    }
    const { view } = response.data;
    setState({ status: "ready", view });
    if (response.data.claimed) {
      const today = view.days.find((day) => day.today);
      if (today !== undefined) track("daily_reward_claimed", { day: dayOfWeek(today, view.days), week: view.week });
      setNotice(t("daily.got", { what: gotText(response.data.coins, response.data.shards) }));
      void loadWallet();
    }
    void loadBadges();
  };

  const ready = state.status === "ready" ? state.view : null;

  return (
    <Screen
      title={t("daily.title")}
      onBack={() => navigation.pop()}
      footer={
        dailyAvailable() ? (
          <Button size="l" block disabled={ready === null || !ready.canClaim} loading={claiming} onClick={() => void claim()}>
            {ready !== null && !ready.canClaim ? t("daily.next", { time: formatCountdown(msUntilReset(Date.now(), "daily")) }) : t("daily.claim")}
          </Button>
        ) : undefined
      }
    >
      <ContentColumn>
        <div className="mt-4 mb-5 flex flex-col items-center gap-3 text-center landscape:hidden">
          <IconEmblem size="l">
            <CalendarCheck size={36} />
          </IconEmblem>
          <p className="max-w-[300px] text-sm text-text-muted">{t("daily.text")}</p>
        </div>

        {!dailyAvailable() ? <InfoNotice text={t("daily.guest")} /> : null}
        {state.status === "loading" && dailyAvailable() ? <p className="text-sm text-text-muted">{t("daily.loading")}</p> : null}
        {state.status === "failed" ? <ErrorState text={t("daily.failed")} onRetry={() => void load()} /> : null}

        {ready === null ? null : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-display text-sm font-bold text-text">{t("daily.week", { week: ready.week })}</p>
              <p className="text-sm font-semibold text-accent">{t("daily.step", { step: formatDecimal(ready.step) })}</p>
            </div>
            <ol className="mt-3 grid grid-cols-4 gap-2 landscape:grid-cols-7">
              {ready.days.map((day, index) => (
                <DayCell key={day.day} day={day} index={index} last={index === ready.days.length - 1} />
              ))}
            </ol>
            {notice === null ? null : <p className="mt-3 text-center text-sm font-semibold text-success">{notice}</p>}
            <p className="mt-4 text-xs text-text-muted">{t("daily.step.hint")}</p>
            {ready.nextStep > ready.step ? <p className="mt-1 text-xs text-text-muted">{t("daily.step.next", { step: formatDecimal(ready.nextStep) })}</p> : null}
          </>
        )}
      </ContentColumn>
    </Screen>
  );
}

function DayCell(props: { day: DailyDay; index: number; last: boolean }): ReactNode {
  const { day } = props;
  const label = day.today && !day.claimed ? t("daily.today") : t("daily.day", { day: props.index + 1 });
  return (
    <li
      aria-current={day.today ? "date" : undefined}
      aria-label={`${t("daily.day", { day: props.index + 1 })}: ${gotText(day.coins, day.shards)}${day.claimed ? `, ${t("daily.claimed")}` : ""}`}
      style={staggerStyle(props.index)}
      className={[
        "relative flex animate-rise-in flex-col items-center justify-between gap-2 overflow-hidden rounded-lg px-1 py-3 text-center",
        day.today ? "surface-card-selected" : "surface-card",
        day.claimed && !day.today ? "opacity-60" : "",
        props.last ? "col-span-2 landscape:col-span-1" : "",
      ].join(" ")}
    >
      <span className={["font-display text-xs font-semibold tracking-wide uppercase", day.today ? "text-accent" : "text-text-muted"].join(" ")}>{label}</span>
      <span aria-hidden="true" className={`inline-flex items-center justify-center gap-1 rounded-md bg-accent/15 ${props.last ? "h-14 px-3" : "size-11"}`}>
        {day.claimed ? <Check size={props.last ? 28 : 20} className="text-success" /> : <CoinIcon size={props.last ? 28 : 20} />}
        {day.shards > 0 && !day.claimed ? <ShardIcon rarity="common" size={22} /> : null}
      </span>
      <span aria-hidden="true" className="min-h-5 font-display text-sm font-bold tabular-nums text-text">
        {formatNumber(day.coins)}
        {day.shards > 0 ? <span className="text-text-muted"> +{day.shards}</span> : null}
      </span>
    </li>
  );
}

function gotText(coins: number, shards: number): string {
  const parts = [coins > 0 ? t("daily.coins", { amount: formatNumber(coins), n: coins }) : null, shards > 0 ? t("daily.shards", { amount: formatNumber(shards), n: shards }) : null];
  return parts.filter((part): part is string => part !== null).join(t("daily.and"));
}
