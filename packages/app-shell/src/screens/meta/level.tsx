import { useEffect, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { ACCOUNT_UNLOCKS, PASSIVES, unlocksAt, WEAPONS } from "@bh/core-game";
import { Card, ContentColumn, Screen, SectionTitle } from "../../design-system/components";
import { CoinIcon, GemIcon } from "../../design-system/components/CurrencyIcons";
import { formatNumber, t } from "../../i18n";
import "../../i18n/account";
import { collectionByLevel, nextUnlockAfter, nextUnlockLabel, unlockLabel, unlocksGainedAt, type CollectionItem, type LevelUnlock } from "../../state/level-unlocks";
import { useNavigation } from "../../state/navigation";
import { useProgress, type ProgressView } from "../../state/progress";
import { ItemIcon, ItemTile } from "../item-icons";
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
            <AccountLevel progress={progress} flush />
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
  const next = all ? null : nextUnlockAfter(props.level);
  const collection = collectionByLevel();
  return (
    <>
      <SectionTitle>{t("level.open")}</SectionTitle>
      <div className="surface-sunken grid gap-4 rounded-lg px-2 py-3 text-sm text-text-muted">
        <CollectionRow
          kind="weapon"
          title={t("level.open.weapons", { open: open.weapons.size, total: WEAPONS.length })}
          items={collection.weapons}
          level={props.level}
          columns="grid-cols-[repeat(auto-fit,minmax(2.75rem,1fr))]"
        />
        <CollectionRow
          kind="passive"
          title={t("level.open.passives", { open: open.passives.size, total: PASSIVES.length })}
          items={collection.passives}
          level={props.level}
          columns="grid-cols-[repeat(auto-fit,minmax(3.75rem,1fr))]"
        />
        <span>
          {t("level.open.slots", {
            weapons: open.limits.weapons,
            attack: open.limits.passives.attack,
            defense: open.limits.passives.defense,
            mobility: open.limits.passives.mobility,
          })}
        </span>
        {all ? <span className="text-text">{t("level.allOpen")}</span> : next === null ? null : <span className="text-text">{nextUnlockLabel(next)}</span>}
      </div>
    </>
  );
}

/**
 * Ряд коллекции (design/art/meta-v2.md §9): открытое — значком своего цвета
 * и именем, закрытое — тенью значка и уровнем, на котором откроется. Видно не
 * только «3 из 6», но и что именно ждёт впереди — цель, а не счётчик.
 */
/** `columns` — колонки по ширине имени: на 320 навыки встают по четыре, на 390 — по пять. */
function CollectionRow(props: { kind: "weapon" | "passive"; title: string; items: CollectionItem[]; level: number; columns: string }): ReactNode {
  return (
    <div>
      <span>{props.title}</span>
      <ul className={`mt-2 grid ${props.columns} gap-x-1 gap-y-2`}>
        {props.items.map((item) => {
          const open = item.level <= props.level;
          const name = t(`${props.kind}.${item.id}.name`);
          return (
            <li key={item.id} className="flex min-w-0 flex-col items-center gap-1 text-center">
              {open ? (
                <ItemTile kind={props.kind} id={item.id} />
              ) : (
                <span role="img" aria-label={name} className="inline-flex size-11 items-center justify-center rounded-md border border-dashed border-border-strong text-text-disabled">
                  <span className="opacity-60">
                    <ItemIcon kind={props.kind} id={item.id} size={22} />
                  </span>
                </span>
              )}
              <span className={`w-full text-[11px] leading-tight tracking-tight ${open ? "text-text" : "text-text-disabled"}`}>
                {open ? name : t("level.collection.at", { level: item.level })}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
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
      {/* Лента ступеней: уровни нанизаны на одну нить, ромб открытия — у
          уровня, который даёт что-то в забег, полый — у уровня с наградой. */}
      <ol className="relative grid gap-2 pl-6">
        <span aria-hidden="true" className="absolute top-5 bottom-5 left-[7px] w-0.5 rounded-pill bg-border" />
        {rows.map((row, index) => (
          <LevelRow key={row.level} row={row} index={index} />
        ))}
      </ol>
    </>
  );
}

function LevelRow(props: { row: UpcomingRow; index: number }): ReactNode {
  const { row } = props;
  const unlocks = unlocksGainedAt(row.level);
  const milestone = unlocks.length > 0;
  return (
    <li className="relative">
      <span
        aria-hidden="true"
        className={`absolute top-5 -left-[22px] size-3 rotate-45 ${milestone ? "bg-accent shadow-[0_0_10px_var(--color-accent-glow)]" : "border-2 border-border-strong bg-bg"}`}
      />
      <Card appearIndex={Math.min(props.index, 6)}>
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
        {milestone ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {unlocks.map((unlock) => (
              <UnlockChip key={`${unlock.kind}:${"id" in unlock ? unlock.id : "category" in unlock ? unlock.category : "weapons"}`} unlock={unlock} />
            ))}
          </div>
        ) : row.reward === null ? (
          // Награда сервера ещё не пришла — без неё строка пустая, скажем, что в забеге нового нет.
          <p className="mt-1 text-xs text-text-muted">{t("level.nothing")}</p>
        ) : null}
        {row.reward === null ? null : <p className="mt-1.5 text-xs text-text-muted">{t("level.itemCap", { cap: row.reward.itemLevelCap })}</p>}
      </Card>
    </li>
  );
}

/** Что откроет уровень — значком предмета или пустым слотом, а не строкой капсом. */
function UnlockChip(props: { unlock: LevelUnlock }): ReactNode {
  const { unlock } = props;
  const label = unlockLabel(unlock);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-sunken py-1 pr-2.5 pl-1 text-xs text-text">
      {unlock.kind === "weapon" || unlock.kind === "passive" ? (
        <ItemTile kind={unlock.kind} id={unlock.id} size="s" />
      ) : (
        <span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-md border border-dashed border-border-strong text-text-muted">
          <Plus size={14} strokeWidth={2.5} />
        </span>
      )}
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </span>
  );
}
