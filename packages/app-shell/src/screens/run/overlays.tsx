import { useEffect, useState, type ReactNode } from "react";
import type { RunResult, UpgradeOption } from "@bh/shared-types";
import { Button, Card, FullscreenButton, Modal, Stat } from "../../design-system/components";
import { formatDuration, formatNumber, t } from "../../i18n";

/**
 * Оверлеи забега: пауза, выбор улучшения и смерть. Показываются поверх
 * **остановленной** канвы — симуляция в этот момент не делает ни шага, и за
 * главный поток соревноваться не с кем (docs/27-design-system-and-app-shell.md §1.2).
 */

/**
 * Сколько оверлей не принимает нажатия после появления.
 *
 * Палец в этот момент ещё ведёт персонажа: без задержки тап по джойстику
 * выбирает улучшение за игрока и мгновенно закрывает экран смерти
 * (docs/26-stage2-plan.md, WP2).
 */
const GUARD_MS = 350;

function useTapGuard(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setReady(true), GUARD_MS);
    return () => clearTimeout(timer);
  }, []);

  return ready;
}

export interface PauseOverlayProps {
  elapsedSec: number;
  onResume(): void;
  onSettings(): void;
  onSurrender(): void;
}

export function PauseOverlay(props: PauseOverlayProps): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const ready = useTapGuard();

  if (confirming) {
    return (
      <Modal
        title={t("run.surrender.title")}
        placement="bottom"
        footer={
          <>
            <Button variant="danger" block disabled={!ready} onClick={props.onSurrender}>
              {t("run.surrender.confirm")}
            </Button>
            <Button variant="ghost" block onClick={() => setConfirming(false)}>
              {t("run.surrender.cancel")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">{t("run.surrender.text")}</p>
      </Modal>
    );
  }

  return (
    <Modal
      title={t("run.pause")}
      footer={
        <>
          <Button block disabled={!ready} onClick={props.onResume}>
            {t("run.pause.resume")}
          </Button>
          <Button variant="secondary" block onClick={props.onSettings}>
            {t("run.pause.settings")}
          </Button>
          {/* Сдача — с подтверждением: случайный тап не должен обнулять забег. */}
          <Button variant="danger" block onClick={() => setConfirming(true)}>
            {t("run.pause.surrender")}
          </Button>
        </>
      }
    >
      <div className="flex items-center justify-between gap-4">
        <Stat label={t("run.death.survived")} value={formatDuration(props.elapsedSec)} large />
        {/* Режим экрана переключается прямо отсюда: забег при этом не
            прерывается (docs/27-design-system-and-app-shell.md §5.2.1). */}
        <FullscreenButton />
      </div>
    </Modal>
  );
}

export interface LevelUpOverlayProps {
  level: number;
  offers: readonly UpgradeOption[];
  queued: number;
  onChoose(optionId: string): void;
}

export function LevelUpOverlay(props: LevelUpOverlayProps): ReactNode {
  const ready = useTapGuard();

  return (
    <Modal title={t("run.levelUp.title", { level: props.level })}>
      <p className="mb-4 text-sm text-text-muted">{t("run.levelUp.subtitle")}</p>
      {/*
        В ландшафте карточки идут в ряд, в портрете — столбцом: высота
        ландшафта на телефоне около 360 px, и три карточки столбцом туда не
        помещаются (docs/27-design-system-and-app-shell.md §5.3).
      */}
      <div className="grid gap-2 landscape:grid-cols-3">
        {props.offers.map((offer) => (
          <Card key={offer.id} disabled={!ready} onClick={() => props.onChoose(offer.id)}>
            <div className="flex items-start justify-between gap-2">
              <span className="font-display text-base text-text">{t(offer.nameKey)}</span>
              <span className="shrink-0 text-xs text-accent">{offerTag(offer)}</span>
            </div>
            <p className="mt-1 text-xs text-text-muted">{t(offer.descriptionKey)}</p>
          </Card>
        ))}
      </div>
      {props.queued > 0 ? (
        <p className="mt-3 text-center text-xs text-text-muted">
          {t("run.levelUp.queued", { count: props.queued })}
        </p>
      ) : null}
    </Modal>
  );
}

/** Новое это оружие или уровень к уже взятому — игрок должен видеть сразу. */
function offerTag(offer: UpgradeOption): string {
  if (offer.kind === "weapon_new" || offer.kind === "passive_new") return t("run.levelUp.new");
  if (offer.kind === "heal") return "";
  return t("run.levelUp.upgrade", { level: offer.level });
}

export interface DeathOverlayProps {
  result: RunResult;
  isNewRecord: boolean;
  diagnostics: boolean;
  onRestart(): void;
  onMenu(): void;
  onShare(): void;
}

export function DeathOverlay(props: DeathOverlayProps): ReactNode {
  const ready = useTapGuard();
  const { result } = props;
  // Сверху то, что тянуло забег: урон по оружиям — главный вход
  // геймдизайнера для баланса (docs/26-stage2-plan.md, WP3).
  const weapons = [...result.weapons].sort((left, right) => right.damage - left.damage);

  return (
    <Modal title={result.outcome === "died" ? t("run.death.title") : t("run.death.abandoned")}>
      {props.isNewRecord ? (
        <p className="mb-3 font-display text-sm text-accent">{t("run.death.record")}</p>
      ) : null}

      <div className="grid grid-cols-2 gap-4 landscape:grid-cols-4">
        <Stat label={t("run.death.survived")} value={formatDuration(result.survivalSec)} large />
        <Stat label={t("run.death.level")} value={String(result.level)} large />
        <Stat label={t("run.death.killed")} value={formatNumber(result.enemiesKilled)} />
        <Stat label={t("run.death.wave")} value={String(result.waveReached)} />
      </div>

      {result.deathCause === null ? null : (
        <p className="mt-3 text-xs text-text-muted">
          {t("run.death.cause", { enemy: result.deathCause })}
        </p>
      )}

      {weapons.length === 0 ? null : (
        <div className="mt-4">
          <h3 className="mb-2 text-xs tracking-wide text-text-muted uppercase">
            {t("run.death.weapons")}
          </h3>
          <ul className="grid gap-1">
            {weapons.map((weapon) => (
              <li key={weapon.id} className="flex items-center justify-between text-sm">
                <span className="text-text">
                  {t(`weapon.${weapon.id}.name`)}
                  <span className="ml-1 text-text-muted">{weapon.level}</span>
                </span>
                <span className="tabular-nums text-text-muted">
                  {formatNumber(weapon.damage)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* seed и runId видны только в режиме диагностики: с ними баг
          воспроизводится, а обычному игроку они ни о чём не говорят. */}
      {props.diagnostics ? (
        <p className="mt-4 font-mono text-[11px] break-all text-text-disabled">
          {t("run.death.diagnostics", { seed: result.seed, runId: result.runId })}
        </p>
      ) : null}

      <div className="mt-5 grid gap-2">
        <Button block disabled={!ready} onClick={props.onRestart}>
          {t("run.death.again")}
        </Button>
        <Button variant="secondary" block onClick={props.onMenu}>
          {t("run.death.menu")}
        </Button>
        <Button variant="ghost" block onClick={props.onShare}>
          {t("run.death.share")}
        </Button>
      </div>
    </Modal>
  );
}
