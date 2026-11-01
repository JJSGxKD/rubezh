import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Card, ErrorState, InfoNotice, SectionTitle } from "../../design-system/components";
import { formatNumber, t } from "../../i18n";
import "../../i18n/tasks";
import { createAchievementsApi, favoriteFailureKey, isOpenAchievement, type AchievementsView, type OpenAchievement } from "../../state/achievements-api";
import { loadBadges } from "../../state/badges-api";
import { track } from "../../state/shell";
import { TASK_NOT_DONE, claimFailureKey, createTasksApi, tasksAvailable } from "../../state/tasks-api";
import { rewardFeedback } from "../../state/ui-feedback";
import { loadWallet } from "../../state/wallet-api";
import { burstAt, RewardBurst, type Burst } from "../reward-burst";
import { ICON_RESOURCE, mainResource } from "../reward-burst-rules";
import { AchievementCardView, CategoryIcon, achievementTitle, categoryLabel } from "./achievement-card";
import { FAVORITES_MAX, cards, groupByCategory, nextFavorites, openedCount } from "./achievements-rules";

/**
 * Витрина достижений — содержимое вкладки «Достижения» на экране заданий
 * (tasks/T-0107, docs/39-retention-mechanics.md К1): шапка с престижем, три
 * любимых и секции по категориям. Прогресс, редкость и престиж считает сервер;
 * награду выдаёт тот же забор, что у заданий.
 *
 * Любимые не рисуются оптимистично: ждём ответ сервера, на ошибке список
 * остаётся прежним и появляется плашка.
 */
type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; view: AchievementsView };

const achievements = createAchievementsApi();
const tasks = createTasksApi();

export function Achievements(props: { onChanged: () => void }): ReactNode {
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [claiming, setClaiming] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const [favoritesBusy, setFavoritesBusy] = useState(false);
  const [favoritesNotice, setFavoritesNotice] = useState<string | null>(null);
  const [burst, setBurst] = useState<Burst | null>(null);

  const load = async (): Promise<void> => {
    setState({ status: "loading" });
    const response = await achievements.load();
    setState(response.ok ? { status: "ready", view: response.data } : { status: "failed" });
  };

  /** Перечитать без «загрузки» на экране — после забора: витрина не мигает. */
  const reload = async (): Promise<void> => {
    const response = await achievements.load();
    if (response.ok) setState({ status: "ready", view: response.data });
  };

  useEffect(() => {
    if (tasksAvailable()) void load();
  }, []);

  if (!tasksAvailable()) return <InfoNotice text={t("tasks.guest")} />;
  if (state.status === "loading") return <p className="mt-4 text-sm text-text-muted">{t("achievements.loading")}</p>;
  if (state.status === "failed") return <ErrorState text={t("achievements.failed")} onRetry={() => void load()} />;

  const { view } = state;

  const claim = async (item: OpenAchievement): Promise<void> => {
    if (claiming !== null) return;
    setClaiming(item.id);
    setNotice(null);
    const response = await tasks.claim(item.id);
    setClaiming(null);
    if (!response.ok) {
      setNotice({ id: item.id, text: t(claimFailureKey(response.code)) });
      // Экран устарел: сервер не считает достижение выполненным — перечитать.
      if (response.code === TASK_NOT_DONE) void reload();
      return;
    }
    if (response.data.claimed) {
      track("achievement_unlocked", { achievement: item.id, kind: item.kind, category: item.category, prestige: item.prestige });
      // Значки вылетают из награды в карточке — снимок до перерисовки.
      const main = mainResource(response.data.credited);
      rewardFeedback(main === null ? null : ICON_RESOURCE[main.icon]);
      if (main !== null) setBurst(burstAt(document.querySelector(`[data-task-reward="${CSS.escape(item.id)}"]`), main.amount, main.icon));
      void loadWallet();
    }
    void loadBadges();
    void reload();
    props.onChanged();
  };

  const saveFavorites = async (ids: string[]): Promise<void> => {
    setFavoritesBusy(true);
    setFavoritesNotice(null);
    const response = await achievements.setFavorites(ids);
    setFavoritesBusy(false);
    if (!response.ok) {
      setFavoritesNotice(t(favoriteFailureKey(response.code)));
      return;
    }
    track("achievement_favorites_set", { count: response.data.favorites.length });
    setState((current) => (current.status === "ready" ? { status: "ready", view: { ...current.view, favorites: response.data.favorites } } : current));
  };

  const toggleFavorite = (item: OpenAchievement): void => {
    if (favoritesBusy) return;
    const change = nextFavorites(view.favorites, item.id, item.done);
    if (!change.ok) {
      setFavoritesNotice(t(change.reason === "full" ? "achievements.favorites.full" : "achievements.favorite.locked"));
      return;
    }
    void saveFavorites(change.ids);
  };

  const open = view.items.filter(isOpenAchievement);
  const favoriteItems = view.favorites.flatMap((id) => open.filter((item) => item.id === id));
  let index = 0;

  return (
    <div>
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="font-display text-base font-bold text-accent">{t("achievements.prestige", { points: formatNumber(view.prestige) })}</span>
          <span className="text-xs text-text-muted">{t("achievements.opened", { done: openedCount(view.items), total: view.items.length })}</span>
        </div>
        <SectionTitle as="h3" spacing="mt-4 mb-2">
          {t("achievements.favorites.title")}
        </SectionTitle>
        <ul className="grid grid-cols-3 gap-2">
          {Array.from({ length: FAVORITES_MAX }, (_, slot) => {
            const item = favoriteItems[slot];
            return item === undefined ? (
              <li key={`empty-${String(slot)}`} aria-hidden="true" className="surface-sunken h-14 rounded-lg" />
            ) : (
              <li key={item.id} className="surface-card relative flex h-14 min-w-0 items-center gap-1.5 rounded-lg py-1 pr-9 pl-2 text-accent">
                <CategoryIcon category={item.category} size={18} />
                <span className="line-clamp-2 min-w-0 text-xs font-semibold text-text">{achievementTitle(item)}</span>
                <button
                  type="button"
                  aria-label={`${t("achievements.favorite.remove")}: ${achievementTitle(item)}`}
                  disabled={favoritesBusy}
                  onClick={() => toggleFavorite(item)}
                  className="absolute inset-y-0 right-0 inline-flex w-9 items-center justify-center text-text-muted disabled:opacity-40"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
        {favoriteItems.length === 0 ? <p className="mt-2 text-xs text-text-muted">{t("achievements.favorites.empty")}</p> : null}
        {favoritesNotice === null ? null : <p className="mt-2 text-xs font-semibold text-text-muted">{favoritesNotice}</p>}
      </Card>

      {view.items.length === 0 ? <p className="mt-4 text-sm text-text-muted">{t("tasks.empty")}</p> : null}
      {groupByCategory(view.items).map((group) => (
        <section key={group.category}>
          <SectionTitle>{categoryLabel(group.category)}</SectionTitle>
          <div className="grid gap-2">
            {cards(group.items).map((card) => {
              const id = card.kind === "ladder" ? card.current.id : card.item.id;
              return (
                <AchievementCardView
                  key={card.kind === "ladder" ? `ladder:${card.ladder}` : id}
                  card={card}
                  index={index++}
                  claiming={claiming === id}
                  notice={notice?.id === id ? notice.text : null}
                  favorites={view.favorites}
                  favoritesBusy={favoritesBusy}
                  onClaim={(item) => void claim(item)}
                  onToggleFavorite={toggleFavorite}
                />
              );
            })}
          </div>
        </section>
      ))}
      {burst === null ? null : <RewardBurst key={burst.key} burst={burst} onDone={() => setBurst(null)} />}
    </div>
  );
}
