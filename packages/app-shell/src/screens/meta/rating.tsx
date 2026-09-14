import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Crown, Trophy } from "lucide-react";
import { DIFFICULTY_IDS, type DifficultyId, type PlaytestLeaderboardEntry } from "@bh/shared-types";
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
import { usePlaytest } from "../../state/playtest";
import type { PlaytestFailure } from "../../state/playtest-api";
import { ItemIcon } from "../item-icons";
import { PlaytestProblem, RankMark, SurvivalTime } from "./playtest-ui";

/**
 * Рейтинг закрытого теста: лучшее время каждого игрока, отдельно по
 * сложностям (docs/26-stage2-plan.md, Р18 и WP13). Время на разных
 * сложностях несравнимо, поэтому общей таблицы нет.
 *
 * Антифрода нет сознательно — это витрина «для интереса», и экран говорит,
 * что данные теста сотрутся.
 */
export function RatingScreen(): ReactNode {
  const [difficultyId, setDifficultyId] = useState<DifficultyId>(() => useMeta.getState().lastDifficultyId);
  const board = usePlaytest((state) => state.leaderboards[difficultyId]);
  const pending = usePlaytest((state) => state.pending);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<PlaytestFailure | null>(null);

  // Ответ на переключённую уже сложность не должен затереть состояние текущей.
  const latest = useRef<DifficultyId>(difficultyId);

  const load = useCallback(async (id: DifficultyId): Promise<void> => {
    latest.current = id;
    setLoading(true);
    setFailure(null);
    // Неотправленные забеги сперва уходят на сервер: иначе игрок не нашёл
    // бы в таблице забег, который только что сыграл.
    await usePlaytest.getState().flush("screen");
    const problem = await usePlaytest.getState().loadLeaderboard(id);
    if (latest.current !== id) return;
    setFailure(problem);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(difficultyId);
  }, [difficultyId, load]);

  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("rating.title")}</PageTitle>
        <p className="mb-3 text-sm text-text-muted">{t("rating.subtitle")}</p>

        <SegmentedControl
          label={t("difficulty.title")}
          items={DIFFICULTY_IDS.map((id) => ({ id, label: t(`difficulty.${id}.name`) }))}
          activeId={difficultyId}
          onSelect={(id) => setDifficultyId(id as DifficultyId)}
        />

        <div className="mt-4 grid grid-cols-1 gap-3" aria-busy={loading}>
          {failure === null ? null : (
            <PlaytestProblem failure={failure} compact={board !== undefined} onRetry={() => void load(difficultyId)} />
          )}

          {board === undefined ? (
            loading ? <BoardSkeleton /> : null
          ) : (
            <>
              <MyPlace
                me={board.me}
                totalPlayers={board.totalPlayers}
                inTable={board.entries.some((entry) => entry.isMe)}
              />
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

        <SectionTitle>{t("rating.later")}</SectionTitle>
        <StubNotice text={t("rating.soon")} />
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

function LeaderboardRow(props: { entry: PlaytestLeaderboardEntry; index: number }): ReactNode {
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
          {entry.isMe ? (
            <span className="shrink-0">
              <Badge tone="accent">{t("rating.you")}</Badge>
            </span>
          ) : null}
        </p>
        <p className="flex min-w-0 items-center gap-1 text-xs text-text-muted">
          <span className="shrink-0 text-weapon">
            <ItemIcon kind="weapon" id={entry.startingWeaponId} size={12} />
          </span>
          <span className="truncate">
            {t("rating.row.meta", {
              weapon: t(`weapon.${entry.startingWeaponId}.name`),
              level: entry.level,
              kills: formatNumber(entry.enemiesKilled),
            })}
          </span>
        </p>
      </div>
      <SurvivalTime seconds={entry.survivalSec} />
    </li>
  );
}

function BoardSkeleton(): ReactNode {
  return (
    <div className="grid gap-2" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="surface-card h-14 animate-pulse rounded-lg" style={staggerStyle(index)} />
      ))}
    </div>
  );
}
