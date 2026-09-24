import type { ReactNode } from "react";
import { Crown, Skull, Trophy, Wrench } from "lucide-react";
import type { RunResult } from "@bh/shared-types";
import { Badge, Button, Modal, Stat, staggerStyle } from "../../design-system/components";
import { formatDuration, formatNumber, hasTranslation, t } from "../../i18n";
import { ItemIcon } from "../item-icons";
import { guarded, useTapGuard } from "./overlay-guard";
import { SecondChance, type SecondChanceProps } from "./SecondChance";

/**
 * Экран смерти. Отдельный чанк (`death-overlay-lazy.tsx`): до первой смерти
 * он не нужен, а весит как треть оверлеев, и первая загрузка за него не
 * платит (docs/27-design-system-and-app-shell.md §3.4).
 */

/**
 * Имя врага для игрока. Врагу, которого геймдизайнер добавил без имени в
 * словаре, лучше показать id, чем ключ перевода.
 */
function enemyName(id: string): string {
  const key = `enemy.${id}.name`;
  return hasTranslation(key) ? t(key) : id;
}

export interface DeathOverlayProps {
  result: RunResult;
  isNewRecord: boolean;
  /** место в рейтинге плейтеста; нет — сервер ещё не ответил или его нет */
  rank?: number | null;
  diagnostics: boolean;
  /** забег с читами учтён в рейтинге по просьбе администратора */
  cheatsCounted?: boolean;
  /**
   * Забег ждёт решения о втором шансе: итог предварительный. Без поля —
   * забег закрыт, и блок второго шанса — только витрина.
   */
  secondChance?: SecondChanceProps;
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
  const topDamage = weapons[0]?.damage ?? 0;

  return (
    <Modal
      title={result.outcome === "died" ? t("run.death.title") : t("run.death.abandoned")}
      icon={props.isNewRecord ? <Crown size={28} /> : <Skull size={26} />}
      size="l"
    >
      {/* Сложность рядом с итогом: рекорд засчитан именно на ней. */}
      <div className="-mt-1 mb-3 flex flex-wrap justify-center gap-2">
        <Badge>{t(`difficulty.${result.difficultyId}.name`)}</Badge>
        {/* Читы — видно сразу: иначе «рекорд» бессмертного забега на скриншоте
            выглядит настоящим. */}
        {result.cheats ? (
          <Badge tone="warning">
            <Wrench size={12} aria-hidden="true" />
            {props.cheatsCounted === true ? t("dev.cheats.counted") : t("dev.cheats.notCounted")}
          </Badge>
        ) : null}
        {props.isNewRecord ? (
          <span className="animate-pop-in" style={staggerStyle(2)}>
            <Badge tone="accent">
              <Crown size={12} aria-hidden="true" />
              {t("run.death.record")}
            </Badge>
          </span>
        ) : null}
        {/* Место приходит с сервера позже итога — плашка появляется, когда
            ответ дошёл, и не задерживает сам экран. */}
        {props.rank === undefined || props.rank === null ? null : (
          <span className="animate-pop-in">
            <Badge tone="info">
              <Trophy size={12} aria-hidden="true" />
              {t("run.death.rank", { rank: props.rank })}
            </Badge>
          </span>
        )}
      </div>

      {/* В ландшафте итоги слева, оружие и кнопки справа — «Ещё раз» видна без
          прокрутки (docs/27-design-system-and-app-shell.md §5.3). */}
      <div className="grid gap-4 landscape:grid-cols-2">
        <div>
          <div className="surface-sunken grid grid-cols-2 gap-4 rounded-lg p-4">
            <Stat
              label={t("run.death.survived")}
              value={formatDuration(result.survivalSec)}
              large
              tone={props.isNewRecord ? "accent" : undefined}
            />
            <Stat label={t("run.death.level")} value={String(result.level)} large />
            <Stat label={t("run.death.killed")} value={formatNumber(result.enemiesKilled)} />
            <Stat label={t("run.death.wave")} value={String(result.waveReached)} />
          </div>

          {result.deathCause === null ? null : (
            <p className="mt-3 text-xs text-text-muted">
              {t("run.death.cause", { enemy: enemyName(result.deathCause) })}
            </p>
          )}

          {/* Второй шанс — только после смерти: сданный забег игрок закончил сам. */}
          {result.outcome === "died" ? (
            <div className="mt-3">
              <SecondChance {...props.secondChance} />
            </div>
          ) : null}
        </div>

        <div>
          {weapons.length === 0 ? null : (
            <div>
              <h3 className="mb-2 font-display text-xs font-semibold tracking-widest text-text-muted uppercase">
                {t("run.death.weapons")}
              </h3>
              <ul className="grid gap-2">
                {weapons.map((weapon, index) => (
                  <li
                    key={weapon.id}
                    className="flex animate-rise-in items-center gap-2 text-sm"
                    style={staggerStyle(index + 1)}
                  >
                    <span className="text-weapon">
                      <ItemIcon kind="weapon" id={weapon.id} size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-text">
                          {t(`weapon.${weapon.id}.name`)}
                          <span className="ml-1 text-text-muted">{weapon.level}</span>
                        </span>
                        <span className="font-display tabular-nums text-text-muted">
                          {formatNumber(weapon.damage)}
                        </span>
                      </span>
                      {/* Доля урона полосой: какое оружие тянуло забег, видно без цифр. */}
                      <span className="surface-sunken mt-1 block h-1 overflow-hidden rounded-pill">
                        <span
                          className="fill-accent block h-full origin-left rounded-pill"
                          style={{
                            transform: `scaleX(${topDamage > 0 ? weapon.damage / topDamage : 0})`,
                          }}
                        />
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* seed и runId видны только в режиме диагностики: с ними баг
              воспроизводится, а обычному игроку они ни о чём не говорят. */}
          {props.diagnostics ? (
            <p className="mt-4 font-mono text-xs break-all text-text-disabled">
              {t("run.death.diagnostics", { seed: result.seed, runId: result.runId })}
            </p>
          ) : null}

          <div className="mt-5 grid gap-2">
            <Button size="l" block glow onClick={guarded(ready, props.onRestart)}>
              {t("run.death.again")}
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" block onClick={props.onMenu}>
                {t("run.death.menu")}
              </Button>
              <Button variant="ghost" block onClick={props.onShare}>
                {t("run.death.share")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
