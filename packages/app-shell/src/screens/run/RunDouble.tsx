import { useEffect, useState, type ReactNode } from "react";
import { Check, Crown, Tv } from "lucide-react";
import { Button } from "../../design-system/components";
import { CoinIcon } from "../../design-system/components/CurrencyIcons";
import { formatNumber, t } from "../../i18n";
import "../../i18n/account";
import { adsPlayable, trackAdReward, watchAd } from "../../state/ad-watch";
import { RUN_ALREADY_DOUBLED, RUN_DOUBLE_COOLDOWN, createRunDoubleApi, doubleButton, doubleForAd, type RunDoubleResult, type RunDoubleView } from "../../state/run-double-api";
import { recheckRestriction } from "../../state/restrictions";
import { uiFeedback } from "../../state/ui-feedback";
import { loadWallet } from "../../state/wallet-api";
import { RestrictedPlaque } from "../meta/restricted-plaque";
import { formatCountdown, useClock } from "../meta/schedule";

/**
 * «Удвоить за рекламу» под наградой экрана смерти (docs/35-stage4-plan.md
 * WP12). Своим чанком: кнопка появляется, когда сервер посчитал награду, и
 * поток рекламы грузится вместе с ней, а не с экраном.
 *
 * Кнопки нет, если удваивать нечего, поздно или рекламы для площадки нет:
 * недоступная кнопка на экране итогов только отвлекала бы от «Ещё раз».
 */

const api = createRunDoubleApi();
/** Удвоение — награда за рекламу: его закрывает то же ограничение (WP44). */
const AD_RESTRICTION = ["ad_rewards"];

/** Отсчёт кулдауна — без секунд. */
const CLOCK_STEP_MS = 15_000;

const STALE_NOTICES: Readonly<Record<string, string>> = {
  [RUN_ALREADY_DOUBLED]: "run.double.already",
  [RUN_DOUBLE_COOLDOWN]: "run.double.cooldown",
};

export interface RunDoubleProps {
  runId: string;
  /** удвоение легло: строка награды показывает монеты с прибавкой */
  onDoubled(credited: number): void;
}

export function RunDouble(props: RunDoubleProps): ReactNode {
  const [view, setView] = useState<RunDoubleView | null>(null);
  const [watching, setWatching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<RunDoubleResult | null>(null);
  const [restricted, setRestricted] = useState(false);

  const load = async (): Promise<void> => {
    const response = await api.view(props.runId);
    // Не ответил сервер — кнопки нет: экран итогов не место для ошибок связи.
    if (response.ok) setView(response.data);
  };

  useEffect(() => {
    void load();
  }, [props.runId]);

  const now = useClock(view?.status === "available", CLOCK_STEP_MS);
  const button = view === null || done !== null || restricted ? ({ kind: "hidden" } as const) : doubleButton(view, now, adsPlayable());

  const double = async (): Promise<void> => {
    if (button.kind !== "ready" || watching) return;
    setWatching(true);
    setNotice(null);
    const outcome = await doubleForAd(props.runId, () => watchAd("run_double"), api, (via) => trackAdReward("run_double", via));
    setWatching(false);
    switch (outcome.kind) {
      case "doubled":
        setDone(outcome.result);
        props.onDoubled(outcome.result.credited);
        uiFeedback("reward");
        void loadWallet();
        return;
      case "stale":
        // Экран устарел — перечитываем: кнопка спрячется или покажет отсчёт.
        setNotice(t(STALE_NOTICES[outcome.code] ?? "run.double.expired"));
        void load();
        return;
      case "closed":
        setNotice(t("run.double.closed"));
        return;
      case "no_ads":
        setNotice(t("run.double.noAds"));
        return;
      case "restricted":
        // Вместо кнопки — что закрыто и почему, коротко: с экрана итогов уходить некуда.
        if ((await recheckRestriction(AD_RESTRICTION)) === "restricted") setRestricted(true);
        else setNotice(t("restricted.lifted"));
        return;
      case "failed":
        setNotice(t("run.double.failed"));
        return;
    }
  };

  if (done !== null) {
    return (
      <p role="status" className="mt-2 flex animate-pop-in items-center gap-1.5 text-sm font-semibold text-accent">
        <Check size={16} aria-hidden="true" />
        {done.credited < done.coins ? t("run.double.capped", { amount: formatNumber(done.credited) }) : t("run.double.done", { amount: formatNumber(done.credited) })}
      </p>
    );
  }

  return (
    <>
      {button.kind === "ready" || button.kind === "wait" ? (
        <div className="mt-2 animate-rise-in">
          <Button variant="secondary" block disabled={button.kind === "wait"} loading={watching} onClick={() => void double()}>
            {button.pass ? <Crown size={18} aria-hidden="true" /> : <Tv size={18} aria-hidden="true" />}
            {button.kind === "wait"
              ? t("run.double.next", { time: formatCountdown(button.untilMs - now) })
              : t(button.pass ? "run.double.vip" : "run.double.ad")}
            <span className="inline-flex items-center gap-1 tabular-nums text-accent">
              <CoinIcon size={16} />+{formatNumber(button.coins)}
            </span>
          </Button>
        </div>
      ) : null}
      {restricted ? <RestrictedPlaque kinds={AD_RESTRICTION} compact className="mt-2" /> : null}
      {button.kind === "doubled" ? <p className="mt-2 text-xs text-text-muted">{t("run.double.done", { amount: formatNumber(button.coins) })}</p> : null}
      {notice === null ? null : (
        <p role="status" className="mt-1.5 text-xs text-text-muted">
          {notice}
        </p>
      )}
    </>
  );
}
