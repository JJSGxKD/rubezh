import type { ReactNode } from "react";
import { Check, Library, Lock, Medal, Star, Swords, Trophy, Users } from "lucide-react";
import { Badge, Button, Card, type BadgeTone } from "../../design-system/components";
import { formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/tasks";
import { trackClick } from "../../state/ui-clicks";
import { uiFeedback } from "../../state/ui-feedback";
import { isOpenAchievement, type AchievementItem, type OpenAchievement } from "../../state/achievements-api";
import { percentText, rarityTier, type AchievementCard, type RarityTier } from "./achievements-rules";
import { goalText, ProgressLine } from "./task-row";
import { RewardChips } from "./task-reward";

/**
 * Карточка витрины достижений (tasks/T-0107): одиночное достижение, лестница
 * одной карточкой с текущей ступенью или закрытое скрытое с подсказкой.
 * Цвета — только токены; новых оттенков у ступеней редкости нет, они
 * различаются подписью и тоном существующей плашки.
 */

const CATEGORY_ICONS: Record<string, typeof Medal> = {
  combat: Swords,
  collection: Library,
  mastery: Medal,
  friends: Users,
};

/** Значок категории; незнакомая (из будущего каталога) — общий кубок. */
export function CategoryIcon(props: { category: string; size?: number }): ReactNode {
  const Icon = CATEGORY_ICONS[props.category] ?? Trophy;
  return <Icon size={props.size ?? 20} aria-hidden="true" />;
}

/** Подпись категории; незнакомой нет в словаре — показывается её id. */
export function categoryLabel(category: string): string {
  const key = `achievements.category.${category}`;
  return hasTranslation(key) ? t(key) : category;
}

/**
 * Название достижения: заголовок каталога (его правят из панели без релиза),
 * без него — словарь девяти старых, без обоих — честный id: достижение с
 * сервера новее клиента лучше показать так, чем пустой строкой.
 */
export function achievementTitle(item: Pick<OpenAchievement, "id" | "title">): string {
  if (item.title !== null) return item.title;
  const key = `achievement.${item.id}.name`;
  return hasTranslation(key) ? t(key) : item.id;
}

const RARITY_TONE: Record<RarityTier, BadgeTone> = { common: "muted", uncommon: "info", rare: "passive", epic: "accent" };

export function AchievementCardView(props: {
  card: AchievementCard;
  index: number;
  /** забор этой карточки в пути */
  claiming: boolean;
  notice: string | null;
  /** любимые игрока, id в порядке слотов */
  favorites: readonly string[];
  favoritesBusy: boolean;
  onClaim: (item: OpenAchievement) => void;
  onToggleFavorite: (item: OpenAchievement) => void;
}): ReactNode {
  const { card } = props;
  const shown: AchievementItem = card.kind === "ladder" ? card.current : card.item;
  if (!isOpenAchievement(shown)) return <ClosedCard item={shown} index={props.index} />;

  const item = shown;
  const claimable = item.done && !item.claimed;
  const tier = rarityTier(item.percent);
  const favorite = props.favorites.includes(item.id);
  const rungs = card.kind === "ladder" && card.rungs.length > 1 ? card.rungs : null;

  return (
    <Card appearIndex={props.index} stripe={claimable ? "accent" : undefined}>
      <div className="flex items-start gap-3">
        <span
          className={[
            "inline-flex size-11 shrink-0 items-center justify-center rounded-md",
            item.done ? "bg-accent/15 text-accent" : "bg-surface-raised text-text-muted",
          ].join(" ")}
        >
          <CategoryIcon category={item.category} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-display text-sm font-bold text-text">{achievementTitle(item)}</span>
            {item.claimed ? (
              <Badge tone="muted">
                <Check size={12} aria-hidden="true" />
                {t("tasks.claimed")}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-text-muted">{goalText(item)}</p>
          {rungs === null ? null : <RungDots rungs={rungs} current={item.id} />}
          {tier === null || item.percent === null || item.percent === undefined ? null : (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
              <span>{t("achievements.rarity", { percent: percentText(item.percent) })}</span>
              <Badge tone={RARITY_TONE[tier]}>{t(`achievements.rarity.${tier}`)}</Badge>
            </p>
          )}
          {item.done ? null : (
            <div className="mt-2">
              <ProgressLine task={item} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {/* Метка — откуда вылетает награда при заборе (`reward-burst.tsx`). */}
          <span data-task-reward={item.id} className="flex flex-col items-end gap-1">
            <RewardChips reward={item.reward} />
          </span>
          {item.prestige > 0 ? (
            <span className="font-display text-xs font-semibold tabular-nums text-accent">{t("achievements.prestigeGain", { points: formatNumber(item.prestige) })}</span>
          ) : null}
          {item.done ? (
            <button
              type="button"
              aria-pressed={favorite}
              aria-label={t(favorite ? "achievements.favorite.remove" : "achievements.favorite.add")}
              title={t(favorite ? "achievements.favorite.remove" : "achievements.favorite.add")}
              disabled={props.favoritesBusy}
              onClick={() => {
                uiFeedback("tap");
                trackClick("favorite");
                props.onToggleFavorite(item);
              }}
              className={[
                "inline-flex size-11 items-center justify-center rounded-md",
                "transition-[transform,color] duration-(--duration-fast) ease-base active:scale-90 disabled:opacity-40",
                favorite ? "text-accent" : "text-text-muted active:text-text",
              ].join(" ")}
            >
              <Star size={20} aria-hidden="true" className={favorite ? "fill-current" : undefined} />
            </button>
          ) : null}
        </div>
      </div>
      {claimable ? (
        <div className="mt-3">
          <Button track="claim" block loading={props.claiming} onClick={() => props.onClaim(item)}>
            {t("tasks.claim")}
          </Button>
        </div>
      ) : null}
      {props.notice === null ? null : <p className="mt-2 text-xs font-semibold text-text-muted">{props.notice}</p>}
    </Card>
  );
}

/** Закрытое скрытое: ни названия, ни цели, ни награды — только подсказка. */
function ClosedCard(props: { item: Exclude<AchievementItem, OpenAchievement>; index: number }): ReactNode {
  return (
    <Card appearIndex={props.index}>
      <div className="flex items-start gap-3">
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-surface-raised text-text-muted">
          <Lock size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <span className="font-display text-sm font-bold text-text">{t("achievements.hidden.title")}</span>
          {props.item.hint === "" ? null : <p className="mt-0.5 text-xs text-text-muted">{props.item.hint}</p>}
        </div>
      </div>
    </Card>
  );
}

/** «Ступень 2 из 4» и ряд точек: закрашены выполненные, обводка — текущая. */
function RungDots(props: { rungs: readonly OpenAchievement[]; current: string }): ReactNode {
  const position = props.rungs.findIndex((rung) => rung.id === props.current) + 1;
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span className="text-xs font-semibold text-text-muted">{t("achievements.rung", { current: position, total: props.rungs.length })}</span>
      <span aria-hidden="true" className="flex items-center gap-1">
        {props.rungs.map((rung) => (
          <span
            key={rung.id}
            className={["size-2 rounded-full", rung.done ? "bg-accent" : "bg-surface-raised", rung.id === props.current ? "ring-2 ring-accent/60" : ""].join(" ")}
          />
        ))}
      </span>
    </div>
  );
}
