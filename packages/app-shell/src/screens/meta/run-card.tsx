import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Trophy } from "lucide-react";
import { Avatar, Badge, ContentColumn, EmptyState, Screen, SectionTitle } from "../../design-system/components";
import { formatDuration, formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/boosts";
import "../../i18n/run-card";
import "../../i18n/season";
import type { ApiFailure } from "../../state/api-request";
import { useNavigation } from "../../state/navigation";
import { createRunsApi, type RunCard } from "../../state/runs-api";
import { GameGlyph, STYLE_GLYPHS } from "../game-glyphs";
import { ItemIcon } from "../item-icons";
import { isEvolutionWeapon } from "../run/evolution-hints";
import { styleAxis } from "./rating-rules";
import { StyleBadge } from "./rating-style";
import { axisCaption, axisName, barShares, cardTitle, evolutionCount } from "./run-card-rules";
import { AXIS_TEXT, RunWeb } from "./run-card-web";
import { SyncProblem } from "./sync-ui";
import { TesterBadge } from "./tester-badge";

/**
 * Карточка забега (tasks/T-0297, Р66, Р152, `design/art/meta-v2.md` §2.4):
 * за что очки и где расти. «Паутина» пяти осей против ожидаемого для силы
 * игрока, разбор очков полосами и сборка. Открывается из рейтинга, с экрана
 * итогов и из истории; ключ забега лежит в навигации, поэтому на карточку
 * можно сослаться стартовым параметром (`state/run-card-start.ts`).
 *
 * Персональных данных нет: имя и фото — те же, что в строке рейтинга.
 */

type Loaded = { status: "loading" } | { status: "hidden" } | { status: "failed"; failure: ApiFailure } | { status: "ready"; card: RunCard };

export function RunCardScreen(): ReactNode {
  const navigation = useNavigation();
  const runId = useNavigation((state) => state.runCardId);
  const [state, setState] = useState<Loaded>({ status: "loading" });

  const load = useCallback(async (): Promise<void> => {
    if (runId === null) {
      setState({ status: "hidden" });
      return;
    }
    setState({ status: "loading" });
    const answer = await createRunsApi().card(runId);
    if (answer.ok) setState({ status: "ready", card: answer.data });
    // Забега нет или он закрыт — одна и та же честная фраза: по ней не угадать, существует ли он.
    else if (answer.code === "run_not_found") setState({ status: "hidden" });
    else setState({ status: "failed", failure: answer.failure });
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen title={state.status === "ready" ? cardTitle(state.card.points) : t("runCard.titleShort")} onBack={() => navigation.pop()}>
      <ContentColumn>
        {state.status === "loading" ? <p className="text-sm text-text-muted">{t("runCard.loading")}</p> : null}
        {state.status === "hidden" ? <EmptyState icon={<Trophy size={26} aria-hidden="true" />} text={`${t("runCard.hidden")}. ${t("runCard.hiddenText")}`} /> : null}
        {state.status === "failed" ? <SyncProblem failure={state.failure} onRetry={() => void load()} /> : null}
        {state.status === "ready" ? <RunCardBody card={state.card} /> : null}
      </ContentColumn>
    </Screen>
  );
}

/** Тело карточки отдельно от загрузки: витрина и тесты рисуют его по готовому ответу. */
export function RunCardBody(props: { card: RunCard }): ReactNode {
  const { card } = props;
  const style = styleAxis(card.style);
  const evolutions = evolutionCount(card.build.weapons, isEvolutionWeapon);
  const bars = barShares(card.axes);
  const sub = card.power === null ? t("runCard.sub", { time: formatDuration(card.survivalSec), level: card.level }) : t("runCard.subPower", { time: formatDuration(card.survivalSec), level: card.level, power: POWER.format(card.power) });

  return (
    <div className="grid gap-4">
      <section className="surface-card rounded-lg p-3">
        <div className="flex items-center gap-3">
          <Avatar name={card.player.name} url={card.player.photoUrl} size={44} />
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 font-display text-base font-bold text-text">
              <span className="max-w-full truncate">{card.player.name}</span>
              {card.player.tester === true ? <TesterBadge /> : null}
            </p>
            <p className="text-xs text-text-muted">{sub}</p>
          </div>
          {style === null ? null : <StyleBadge axis={style} large />}
        </div>
        <RunWeb axes={card.axes} cap={card.cap} />
        <p className="text-center text-xs text-text-muted">{card.mine ? t("runCard.legendMine") : t("runCard.legend")}</p>
      </section>

      <section>
        <SectionTitle>{t("runCard.sec.breakdown")}</SectionTitle>
        <ul className="grid gap-2">
          {card.axes.map((axis, index) => {
            const bar = bars[index];
            const caption = axisCaption(axis.axis, card, evolutions);
            return (
              <li key={axis.axis} className="grid grid-cols-[1.375rem_5.75rem_minmax(0,1fr)_3.25rem] items-center gap-2">
                <GameGlyph glyph={STYLE_GLYPHS[axis.axis]} size={22} className={AXIS_TEXT[axis.axis]} />
                <p className="font-display text-xs leading-tight text-text">
                  {axisName(axis.axis)}
                  {caption === null ? null : <small className="block font-body text-[10.5px] font-normal text-text-muted">{caption}</small>}
                </p>
                {/* Полоса — слагаемое очков, черта — слагаемое ожидаемого на той же шкале. Длина — transform, а не ширина. */}
                <span aria-hidden="true" className="relative block h-2.5 rounded-pill bg-text/10">
                  <span className={`block h-full origin-left rounded-pill bg-current ${AXIS_TEXT[axis.axis]}`} style={{ transform: `scaleX(${bar?.share ?? 0})` }} />
                  <span className="absolute -top-[3px] -bottom-[3px] w-0.5 bg-text opacity-55" style={{ left: `${(bar?.expectedShare ?? 0) * 100}%` }} />
                </span>
                <span className="text-right font-display text-sm font-bold tabular-nums text-text">
                  <span aria-hidden="true">{formatNumber(axis.points)}</span>
                  <span className="sr-only">{t("runCard.bar", { name: axisName(axis.axis), points: axis.points, expected: formatNumber(axis.expectedPoints) })}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <SectionTitle>{t("runCard.sec.build")}</SectionTitle>
        <Build card={card} />
      </section>
    </div>
  );
}

const POWER = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

function nameOf(prefix: string, id: string): string {
  const key = `${prefix}.${id}.name`;
  return hasTranslation(key) ? t(key) : id;
}

/** Сборка: оружие с уровнями, эволюции отмечены, навыки и бусты. Набор не сохранился — так и сказано. */
function Build(props: { card: RunCard }): ReactNode {
  const { weapons, passives, boosts } = props.card.build;
  if (weapons.length === 0 && passives.length === 0 && boosts.length === 0) return <p className="text-xs text-text-muted">{t("runCard.build.empty")}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t("runCard.sec.build")}>
      {weapons.map((weapon) => {
        const evolved = isEvolutionWeapon(weapon.id);
        return (
          <li key={`w-${weapon.id}`} className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs ${evolved ? "border-elite/60 text-elite" : "border-weapon/40 text-weapon"}`}>
            <ItemIcon kind="weapon" id={weapon.id} size={14} />
            <span className="text-text">{nameOf("weapon", weapon.id)}</span>
            <span className="font-display font-bold tabular-nums">{evolved ? t("runCard.build.evolved") : t("runCard.build.level", { level: weapon.level })}</span>
          </li>
        );
      })}
      {passives.map((passive) => (
        <li key={`p-${passive.id}`} className="inline-flex items-center gap-1 rounded-sm border border-passive/40 px-1.5 py-0.5 text-xs text-passive">
          <ItemIcon kind="passive" id={passive.id} size={14} />
          <span className="text-text">{nameOf("passive", passive.id)}</span>
          <span className="font-display font-bold tabular-nums">{passive.level}</span>
        </li>
      ))}
      {boosts.map((boost) => (
        <li key={`b-${boost}`}>
          <Badge tone="accent">{nameOf("boost", boost)}</Badge>
        </li>
      ))}
    </ul>
  );
}
