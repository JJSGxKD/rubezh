import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Crown, Trophy } from "lucide-react";
import { DIFFICULTY_IDS, type DifficultyId, type LeaderboardEntry } from "@bh/shared-types";
import {
  Avatar,
  Badge,
  ContentColumn,
  PageTitle,
  Screen,
  SectionTitle,
  SegmentedControl,
  StubNotice,
  staggerStyle,
} from "../../design-system/components";
import { formatNumber, t } from "../../i18n";
import { useMeta } from "../../state/meta";
import { useNavigation } from "../../state/navigation";
import type { ApiFailure } from "../../state/api-request";
import { useRestricted } from "../../state/restrictions";
import { useRuns } from "../../state/runs";
import { ItemIcon } from "../item-icons";
import "../../i18n/season";
import { ClaimArea } from "./rating-rewards";
import { BoardSkeleton, SeasonTab, useSeasonOverview } from "./rating-season";
import { RestrictedPlaque } from "./restricted-plaque";
import { SessionNotice, useSessionNotice } from "./session-notice";
import { RankMark, SurvivalTime, SyncProblem } from "./sync-ui";
import { TesterBadge } from "./tester-badge";

/**
 * Рейтинг закрытого теста: лучшее время каждого игрока, отдельно по
 * сложностям (docs/26-stage2-plan.md, Р18 и WP13). Время на разных
 * сложностях несравнимо, поэтому общей таблицы нет.
 *
 * Таблица — по аккаунтам и из базы: в неё попадает забег, прошедший проверки
 * антифрода (docs/34-stage3-plan.md, WP4). Подозрительный забег остаётся в
 * профиле, но не здесь.
 */
/** Рейтинг закрывает своё ограничение (WP44); о молчаливом игрок не узнаёт — у него тень. */
const RATING_RESTRICTION = ["leaderboard"];

/**
 * Вкладки рейтинга (tasks/T-0111): «Неделя» и «Друзья» живут в `rating-season.tsx`
 * и есть, только когда сезоны включены; «Всё время» — прежний экран без изменений.
 */
type RatingTab = "week" | "all" | "friends";
const TAB_IDS: readonly RatingTab[] = ["week", "all", "friends"];

export function RatingScreen(): ReactNode {
  const [difficultyId, setDifficultyId] = useState<DifficultyId>(() => useMeta.getState().lastDifficultyId);
  const board = useRuns((state) => state.leaderboards[difficultyId]);
  const pending = useRuns((state) => state.pending);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const notice = useSessionNotice();
  const restricted = useRestricted(RATING_RESTRICTION);
  const navigation = useNavigation();
  const { overview, receivedAt, reload } = useSeasonOverview();
  const [picked, setPicked] = useState<RatingTab | null>(null);
  const seasons = overview?.enabled === true ? overview : null;
  // Пока обзор не пришёл, вкладки нет: таблицу «Всё время» не грузим зря, а потом не перебиваем.
  const tab: RatingTab | null = overview === null ? null : (picked ?? (seasons?.season != null ? "week" : "all"));

  // Ответ на переключённую уже сложность не должен затереть состояние текущей.
  const latest = useRef<DifficultyId>(difficultyId);

  const load = useCallback(async (id: DifficultyId): Promise<void> => {
    latest.current = id;
    setLoading(true);
    setFailure(null);
    // Неотправленные забеги сперва уходят на сервер: иначе игрок не нашёл
    // бы в таблице забег, который только что сыграл.
    await useRuns.getState().flush("screen");
    const problem = await useRuns.getState().loadLeaderboard(id);
    if (latest.current !== id) return;
    setFailure(problem);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (tab === "all") void load(difficultyId);
  }, [tab, difficultyId, load]);

  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("rating.title")}</PageTitle>
        <p className="mb-3 text-sm text-text-muted">{t("rating.subtitle")}</p>

        {seasons === null ? null : <ClaimArea pending={seasons.pending} reload={reload} />}
        {seasons === null || tab === null ? null : (
          <SegmentedControl
            track="rating_tab"
            label={t("rating.tabs")}
            items={TAB_IDS.map((id) => ({ id, label: t(`rating.tab.${id}`) }))}
            activeId={tab}
            onSelect={(id) => setPicked(id as RatingTab)}
          />
        )}

        {tab === null ? <BoardSkeleton /> : null}
        {seasons !== null && (tab === "week" || tab === "friends") ? (
          <div className="mt-4">
            <SeasonTab
              scope={tab === "week" ? "all" : "friends"}
              data={seasons}
              receivedAt={receivedAt}
              reload={reload}
              restriction={RATING_RESTRICTION}
              row={(entry, index) => <LeaderboardRow key={`${entry.rank}-${entry.name}`} entry={entry} index={index} />}
              onInvite={() => navigation.resetTo("friends")}
            />
          </div>
        ) : null}

        {tab === "all" ? (
          <>
            <SegmentedControl track="difficulty"
              label={t("difficulty.title")}
              items={DIFFICULTY_IDS.map((id) => ({ id, label: t(`difficulty.${id}.name`) }))}
              activeId={difficultyId}
              onSelect={(id) => setDifficultyId(id as DifficultyId)}
            />

            <div className="mt-4 grid grid-cols-1 gap-3" aria-busy={loading}>
              {/* Нет сессии — сказать почему; ошибка запроса лишь повторила бы то
                  же другими словами, а у блокировки ещё и потеряла бы причину. */}
              {notice !== null ? (
                <SessionNotice notice={notice} />
              ) : failure === null ? null : (
                <SyncProblem failure={failure} compact={board !== undefined} onRetry={() => void load(difficultyId)} />
              )}

              {board === undefined ? (
                loading ? <BoardSkeleton /> : null
              ) : (
                <>
                  {/* Под ограничением места нет, и «сыграйте забег» соврало бы — вместо него плашка. */}
                  <RestrictedPlaque kinds={RATING_RESTRICTION} />
                  {restricted ? null : (
                    <MyPlace
                      me={board.me}
                      totalPlayers={board.totalPlayers}
                      inTable={board.entries.some((entry) => entry.isMe)}
                    />
                  )}
                  {board.entries.length === 0 ? (
                    <p className="surface-sunken rounded-lg p-4 text-center text-sm text-text-muted">
                      {t("rating.empty")}
                    </p>
                  ) : (
                    <ol className="grid grid-cols-1 gap-2">
                      {board.entries.map((entry, index) => (
                        <LeaderboardRow key={`${entry.rank}-${entry.name}`} entry={entry} index={index} />
                      ))}
                    </ol>
                  )}
                </>
              )}

              {pending > 0 ? (
                <p className="text-center text-xs text-text-muted">{t("rating.pending", { count: pending })}</p>
              ) : null}
            </div>

          </>
        ) : null}

        {overview !== null && seasons === null ? (
          <>
            <SectionTitle>{t("rating.later")}</SectionTitle>
            <StubNotice text={t("rating.soon")} />
          </>
        ) : null}
      </ContentColumn>
    </Screen>
  );
}

function MyPlace(props: {
  me: { rank: number; survivalSec: number } | null;
  totalPlayers: number;
  inTable: boolean;
}): ReactNode {
  if (props.me === null) {
    return (
      <div className="surface-sunken flex items-center gap-3 rounded-lg p-3">
        <Trophy size={20} aria-hidden="true" className="shrink-0 text-text-muted" />
        <p className="text-sm text-text-muted">{t("rating.me.none")}</p>
      </div>
    );
  }

  return (
    <div className="surface-card-selected flex items-center gap-3 rounded-lg p-3">
      <RankMark rank={props.me.rank} />
      <div className="min-w-0 flex-1">
        <p className="font-display text-sm font-bold text-text">{t("rating.me.title")}</p>
        <p className="text-xs text-text-muted">
          {props.inTable
            ? t("rating.me.of", { total: props.totalPlayers })
            : t("rating.me.below", { total: props.totalPlayers })}
        </p>
      </div>
      <SurvivalTime seconds={props.me.survivalSec} tone="accent" />
    </div>
  );
}

function LeaderboardRow(props: { entry: LeaderboardEntry; index: number }): ReactNode {
  const { entry } = props;

  return (
    <li
      className={[
        "flex animate-rise-in items-center gap-3 rounded-lg px-3 py-2.5",
        entry.isMe ? "surface-card-selected" : "surface-card",
      ].join(" ")}
      // Лесенка только у первых строк: пятидесятая строка, выезжающая через
      // две секунды, выглядит как тормоза.
      style={staggerStyle(Math.min(props.index, 8))}
    >
      <RankMark rank={entry.rank} />
      <Avatar name={entry.name} url={entry.photoUrl} size={36} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-text">
          {entry.rank === 1 ? <Crown size={14} aria-hidden="true" className="shrink-0 text-elite" /> : null}
          <span className="truncate">{entry.name}</span>
          {entry.tester === true ? <TesterBadge /> : null}
          {entry.prestige !== undefined && entry.prestige > 0 ? <PrestigeMark points={entry.prestige} /> : null}
          {entry.isMe ? (
            <span className="shrink-0">
              <Badge tone="accent">{t("rating.you")}</Badge>
            </span>
          ) : null}
        </p>
        <RatingMeta weaponId={entry.startingWeaponId} level={entry.level} kills={entry.enemiesKilled} />
      </div>
      <SurvivalTime seconds={entry.survivalSec} />
    </li>
  );
}

/**
 * Очки престижа за достижения (T-0107) рядом с именем. Имя режется многоточием,
 * значок — нет: число обрезанным вводит в заблуждение. Скринридеру — словами,
 * знак звезды ему ничего не говорит.
 */
function PrestigeMark(props: { points: number }): ReactNode {
  return (
    <span className="shrink-0 font-display text-xs font-semibold tabular-nums whitespace-nowrap text-accent">
      <span aria-hidden="true">{`★ ${formatNumber(props.points)}`}</span>
      <span className="sr-only">{t("rating.prestige", { points: formatNumber(props.points) })}</span>
    </span>
  );
}

/**
 * Подпись строки: оружие · уровень · убито. Поля — отдельными кусками в
 * строку высотой в одну строку текста: поле, которому не хватило места,
 * переносится в скрытую вторую строку целиком, со своей точкой, а не режется
 * многоточием на полуслове — «убит…» на 320 px читалось обрывком (U-14).
 */
export function RatingMeta(props: { weaponId: string; level: number; kills: number }): ReactNode {
  return (
    <p className="flex h-lh min-w-0 flex-wrap items-center gap-x-1 overflow-hidden text-xs text-text-muted">
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
        <span className="text-weapon">
          <ItemIcon kind="weapon" id={props.weaponId} size={12} />
        </span>
        <span>{t(`weapon.${props.weaponId}.name`)}</span>
      </span>
      <span className="shrink-0 whitespace-nowrap">{`· ${t("rating.row.level", { level: props.level })}`}</span>
      <span className="shrink-0 whitespace-nowrap">{`· ${t("rating.row.kills", { kills: formatNumber(props.kills) })}`}</span>
    </p>
  );
}
