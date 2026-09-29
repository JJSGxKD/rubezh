import { useEffect, type ReactNode } from "react";
import { ACCOUNT_UNLOCKS, PASSIVES, unlocksAt, WEAPONS } from "@bh/core-game";
import { Badge, Card, ContentColumn, Screen, SectionTitle } from "../../design-system/components";
import { CoinIcon, GemIcon } from "../../design-system/components/CurrencyIcons";
import { formatNumber, t } from "../../i18n";
import "../../i18n/account";
import { unlockLabel, unlocksGainedAt } from "../../state/level-unlocks";
import { useNavigation } from "../../state/navigation";
import { useProgress, type ProgressView } from "../../state/progress";
import { AccountLevel } from "./account-level";

/**
 * Экран уровня аккаунта (docs/35-stage4-plan.md Р42): что даёт каждый
 * ближайший уровень — награду, оружие, навыки и слоты, потолок уровня
 * предметов — и что открыто сейчас. Награды и потолок считает сервер, а что
 * уровень открывает в забеге — таблица разблокировок движка, та же, что
 * решает забег.
 */

/** Сколько уровней показать, если сервер не прислал ближайшие, — как у сервера. */
const FALLBACK_UPCOMING = 5;

export function LevelScreen(): ReactNode {
  const navigation = useNavigation();
  const progress = useProgress((state) => state.progress);

  useEffect(() => {
    void import("../../state/progress-api").then(({ loadProgress }) => loadProgress());
  }, []);

  return (
    <Screen title={t("level.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <p className="text-sm text-text-muted">{t("level.intro")}</p>
        {progress === null ? null : (
          <Card>
            <AccountLevel progress={progress} />
          </Card>
        )}
        <OpenNow level={progress?.level ?? 1} />
        <Upcoming progress={progress} />
      </ContentColumn>
    </Screen>
  );
}

function OpenNow(props: { level: number }): ReactNode {
  const open = unlocksAt(ACCOUNT_UNLOCKS, props.level);
  const all = open.weapons.size === WEAPONS.length && open.passives.size === PASSIVES.length;
  return (
    <>
      <SectionTitle>{t("level.open")}</SectionTitle>
      <div className="surface-sunken grid gap-1 rounded-lg px-4 py-3 text-sm text-text-muted">
        <span>{t("level.open.weapons", { open: open.weapons.size, total: WEAPONS.length })}</span>
        <span>{t("level.open.passives", { open: open.passives.size, total: PASSIVES.length })}</span>
        <span>
          {t("level.open.slots", {
            weapons: open.limits.weapons,
            attack: open.limits.passives.attack,
            defense: open.limits.passives.defense,
            mobility: open.limits.passives.mobility,
          })}
        </span>
        {all ? <span className="text-text">{t("level.allOpen")}</span> : null}
      </div>
    </>
  );
}

interface UpcomingRow {
  level: number;
  reward: { coins: number; gems: number; itemLevelCap: number } | null;
}

function Upcoming(props: { progress: ProgressView | null }): ReactNode {
  const level = props.progress?.level ?? 1;
  // Сервер старше экрана уровня ближайших уровней не пришлёт — тогда видно
  // хотя бы, что они откроют.
  const rows: UpcomingRow[] =
    props.progress?.upcoming !== undefined
      ? props.progress.upcoming.map((row) => ({ level: row.level, reward: { coins: row.coins, gems: row.gems, itemLevelCap: row.itemLevelCap } }))
      : Array.from({ length: FALLBACK_UPCOMING }, (_, index) => ({ level: level + index + 1, reward: null }));
  if (rows.length === 0) return null;
  return (
    <>
      <SectionTitle>{t("level.next")}</SectionTitle>
      <div className="grid gap-2">
        {rows.map((row, index) => (
          <LevelRow key={row.level} row={row} index={index} />
        ))}
      </div>
    </>
  );
}

function LevelRow(props: { row: UpcomingRow; index: number }): ReactNode {
  const { row } = props;
  const unlocks = unlocksGainedAt(row.level);
  return (
    <Card appearIndex={Math.min(props.index, 6)} {...(unlocks.length > 0 ? { stripe: "weapon" as const } : {})}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-display text-base font-bold text-text">{t("level.row", { level: row.level })}</span>
        {row.reward === null ? null : (
          <span className="inline-flex items-center gap-1 text-sm tabular-nums text-text">
            <CoinIcon size={14} />
            {row.reward.gems > 0 ? (
              <>
                {t("level.rewardGems", { coins: formatNumber(row.reward.coins), gems: row.reward.gems })}
                <GemIcon size={14} />
              </>
            ) : (
              t("level.reward", { coins: formatNumber(row.reward.coins) })
            )}
          </span>
        )}
      </div>
      {unlocks.length === 0 ? (
        <p className="mt-1 text-xs text-text-muted">{t("level.nothing")}</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {unlocks.map((unlock) => (
            <Badge key={`${unlock.kind}:${"id" in unlock ? unlock.id : "category" in unlock ? unlock.category : "weapons"}`} tone="accent">
              {unlockLabel(unlock)}
            </Badge>
          ))}
        </div>
      )}
      {row.reward === null ? null : <p className="mt-1.5 text-xs text-text-muted">{t("level.itemCap", { cap: row.reward.itemLevelCap })}</p>}
    </Card>
  );
}
