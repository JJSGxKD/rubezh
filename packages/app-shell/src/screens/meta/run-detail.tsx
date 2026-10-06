import { useEffect, useState, type ReactNode } from "react";
import { Badge, Button, ErrorState, Modal, Stat, type BadgeTone } from "../../design-system/components";
import { CoinIcon } from "../../design-system/components/CurrencyIcons";
import { formatDuration, formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/account";
import "../../i18n/arsenal";
import "../../i18n/boosts";
import { damageShares, loadRunDetail, type RunDetail } from "../../state/run-detail-api";
import { ItemIcon } from "../item-icons";
import { itemLabel, slotIcon, toneOf } from "./arsenal-parts";

/**
 * Лист забега из «Последних забегов» профиля (docs/35-stage4-plan.md, WP4;
 * docs/27-design-system-and-app-shell.md §6): чем воевал, кого бил, от кого
 * погиб, что получил. Числа — с сервера, как он записал итог: лист не
 * пересчитывает забег на устройстве.
 */

type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; run: RunDetail };

const DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

const RATING_TONE: Record<string, BadgeTone> = { ranked: "accent", cheats: "warning", restricted: "warning" };

function nameOf(prefix: string, id: string): string {
  const key = `${prefix}.${id}.name`;
  return hasTranslation(key) ? t(key) : id;
}

export function RunDetailSheet(props: { runId: string; onClose(): void }): ReactNode {
  const [state, setState] = useState<Loaded>({ status: "loading" });

  const load = async (): Promise<void> => {
    setState({ status: "loading" });
    const response = await loadRunDetail(props.runId);
    setState(response.ok ? { status: "ready", run: response.data } : { status: "failed" });
  };

  useEffect(() => {
    void load();
  }, [props.runId]);

  const title = state.status === "ready" ? t("runDetail.title", { date: DATE.format(new Date(state.run.at)) }) : t("runDetail.titleShort");

  return (
    <Modal
      title={title}
      placement="bottom"
      onDismiss={props.onClose}
      footer={
        <Button variant="ghost" block onClick={props.onClose}>
          {t("app.close")}
        </Button>
      }
    >
      {state.status === "loading" ? <p className="text-sm text-text-muted">{t("runDetail.loading")}</p> : null}
      {state.status === "failed" ? <ErrorState text={t("runDetail.failed")} onRetry={() => void load()} /> : null}
      {state.status === "ready" ? <Body run={state.run} /> : null}
    </Modal>
  );
}

function Part(props: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="grid gap-2">
      <h3 className="font-display text-xs font-semibold tracking-widest text-text-muted uppercase">{props.title}</h3>
      {props.children}
    </section>
  );
}

function Body(props: { run: RunDetail }): ReactNode {
  const { run } = props;
  const ratingKey = `runDetail.rating.${run.rating}`;
  // Подробностей нет — забег записан сборкой до листа: честно сказать, а не рисовать нули.
  const old = run.passives.length === 0 && run.damageTaken === null;
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-weapon/15 text-weapon">
          <ItemIcon kind="weapon" id={run.startingWeaponId} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-base font-bold text-text">{nameOf("weapon", run.startingWeaponId)}</p>
          <p className="text-xs text-text-muted">{outcomeLine(run)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge>{t(`difficulty.${run.difficultyId}.name`)}</Badge>
          <Badge tone={RATING_TONE[run.rating] ?? "muted"}>{hasTranslation(ratingKey) ? t(ratingKey) : t("runDetail.rating.review")}</Badge>
        </div>
      </div>

      <div className="surface-sunken grid grid-cols-3 gap-3 rounded-md px-3 py-2">
        <Stat label={t("runDetail.time")} value={formatDuration(run.survivalSec)} />
        <Stat label={t("runDetail.level")} value={formatNumber(run.level)} />
        <Stat label={t("runDetail.kills")} value={formatNumber(run.enemiesKilled)} />
        {run.waveReached === null ? null : <Stat label={t("runDetail.wave")} value={formatNumber(run.waveReached)} />}
        {run.xpCollected === null ? null : <Stat label={t("runDetail.xp")} value={formatNumber(run.xpCollected)} />}
        {run.damageTaken === null ? null : <Stat label={t("runDetail.damageTaken")} value={formatNumber(run.damageTaken)} />}
      </div>

      {old ? <p className="text-xs text-text-muted">{t("runDetail.old")}</p> : null}

      <Reward run={run} />

      {run.loot.length === 0 ? null : (
        <Part title={t("runDetail.loot")}>
          <ul className="grid gap-1.5">
            {run.loot.map((item, index) => {
              const tone = toneOf(item.rarity);
              return (
                <li key={`${item.slot}-${index}`} className="flex items-center gap-2 text-sm">
                  <span className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md ring-1 ${tone.tile}`}>{slotIcon(item.slot, 16)}</span>
                  <span className={`min-w-0 ${tone.text}`}>{itemLabel(item)}</span>
                </li>
              );
            })}
          </ul>
        </Part>
      )}

      {run.weapons.length === 0 ? null : <Weapons run={run} />}

      {run.passives.length === 0 ? null : (
        <Part title={t("runDetail.passives")}>
          <ul className="flex flex-wrap gap-1.5">
            {run.passives.map((passive) => (
              <li key={passive.id} className="inline-flex items-center gap-1 rounded-sm border border-passive/40 px-1.5 py-0.5 text-xs text-passive">
                <ItemIcon kind="passive" id={passive.id} size={14} />
                <span className="text-text">{nameOf("passive", passive.id)}</span>
                <span className="font-display font-bold tabular-nums">{passive.level}</span>
              </li>
            ))}
          </ul>
        </Part>
      )}

      {run.boosts.length === 0 ? null : (
        <Part title={t("runDetail.boosts")}>
          <ul className="flex flex-wrap gap-1.5">
            {run.boosts.map((boost) => (
              <li key={boost}>
                <Badge tone="accent">{nameOf("boost", boost)}</Badge>
              </li>
            ))}
          </ul>
        </Part>
      )}

      {run.topKills.length === 0 ? null : (
        <Part title={t("runDetail.topKills")}>
          <dl className="surface-sunken grid gap-1 rounded-md px-3 py-2">
            {run.topKills.map((kill) => (
              <div key={kill.enemy} className="flex items-baseline justify-between gap-3 text-sm">
                <dt className="min-w-0 truncate text-text-muted">{nameOf("enemy", kill.enemy)}</dt>
                <dd className="shrink-0 font-display font-semibold tabular-nums text-text">{formatNumber(kill.count)}</dd>
              </div>
            ))}
          </dl>
        </Part>
      )}
    </div>
  );
}

function outcomeLine(run: RunDetail): string {
  const end = run.outcome === "abandoned" ? t("runDetail.abandoned") : run.deathCause === null ? t("runDetail.died") : t("runDetail.diedBy", { enemy: nameOf("enemy", run.deathCause) });
  return run.continues > 0 ? `${end} · ${t("runDetail.continues", { n: run.continues })}` : end;
}

/** Урон оружия — полосой доли, как в «Характеристиках» забега: что тащило забег, видно сразу. */
function Weapons(props: { run: RunDetail }): ReactNode {
  const shares = damageShares(props.run.weapons);
  return (
    <Part title={t("runDetail.weapons")}>
      <ul className="grid gap-2">
        {props.run.weapons.map((weapon, index) => {
          const share = shares[index] ?? null;
          return (
            <li key={weapon.id} className="grid gap-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-weapon">
                  <ItemIcon kind="weapon" id={weapon.id} size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate text-text">{nameOf("weapon", weapon.id)}</span>
                <span className="text-xs text-text-muted">{t("runDetail.weaponLevel", { level: weapon.level })}</span>
              </div>
              {share === null || weapon.damage === null ? null : (
                <>
                  <span className="surface-sunken block h-1.5 overflow-hidden rounded-pill">
                    <span className="fill-accent block h-full origin-left rounded-pill" style={{ transform: `scaleX(${share})` }} />
                  </span>
                  <span className="text-xs text-text-muted">{t("runDetail.damage", { damage: formatNumber(weapon.damage), share: Math.round(share * 100) })}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Part>
  );
}

/** Награда — тем же языком, что на экране итогов: монеты, опыт, новый уровень или почему без неё. */
function Reward(props: { run: RunDetail }): ReactNode {
  const { reward } = props.run;
  if (reward === null) return null;
  if (reward.status === "pending") return <p className="text-sm text-text-muted">{t("run.reward.pending")}</p>;
  if (reward.status !== "granted") {
    const key = `run.reward.none.${reward.reason ?? "other"}`;
    return <p className="text-sm text-text-muted">{hasTranslation(key) ? t(key) : t("run.reward.none.other")}</p>;
  }
  return (
    <Part title={t("runDetail.reward")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text">
        <span className="inline-flex items-center gap-1.5 font-display font-bold tabular-nums">
          <CoinIcon size={16} />
          {t("run.reward.coins", { amount: formatNumber(reward.coins) })}
        </span>
        <span className="font-display font-bold tabular-nums text-xp">{t("run.reward.xp", { amount: formatNumber(reward.xp) })}</span>
        {reward.levelAfter > reward.levelBefore ? (
          <span className="text-accent">{t("runDetail.levelUp", { from: reward.levelBefore, to: reward.levelAfter })}</span>
        ) : null}
      </div>
    </Part>
  );
}
