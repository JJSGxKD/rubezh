import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Crown, ShieldCheck, Trophy } from "lucide-react";
import type { LeaderboardEntry, LeaderboardMe } from "@bh/shared-types";
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
import { formatDuration, formatNumber, t } from "../../i18n";
import { RATED_DIFFICULTY_ID } from "../../state/difficulty";
import { useNavigation } from "../../state/navigation";
import type { ApiFailure } from "../../state/api-request";
import { useRestricted } from "../../state/restrictions";
import { useRuns } from "../../state/runs";
import { ItemIcon } from "../item-icons";
import "../../i18n/season";
import { ClaimArea } from "./rating-rewards";
import { Podium } from "./rating-podium";
import { boardScoring, divisionId, nextPlace, scoreOf, styleAxis, type RatingCircle, type Scoring } from "./rating-rules";
import { BoardSkeleton, SeasonTab, useSeasonBoard, useSeasonOverview, weekScoring, type BoardListView } from "./rating-season";
import { DivisionWord, StyleBadge } from "./rating-style";
import { RestrictedPlaque } from "./restricted-plaque";
import { RowOpener, entryRunId } from "./run-card-link";
import { SessionNotice, useSessionNotice } from "./session-notice";
import { RankMark, SyncProblem } from "./sync-ui";
import { TesterBadge } from "./tester-badge";

/**
 * Рейтинг: лучший забег каждого игрока по очкам эффективности (docs/26-stage2-plan.md,
 * Р18 и WP13; очки и стиль — Р66, Р152, tasks/T-0296). Сложность одна (Р126),
 * поэтому таблица одна; обучающий забег в неё не идёт.
 *
 * Таблица — по аккаунтам и из базы: в неё попадает забег, прошедший проверки
 * антифрода (docs/34-stage3-plan.md, WP4). Подозрительный забег остаётся в
 * профиле, но не здесь.
 */
/** Рейтинг закрывает своё ограничение (WP44); о молчаливом игрок не узнаёт — у него тень. */
const RATING_RESTRICTION = ["leaderboard"];

/**
 * Периоды рейтинга: «Неделя» — сезон (понедельник по Гринвичу), с кругами
 * «Все», «Друзья» и «Мой дивизион» (`rating-season.tsx`), есть, только когда
 * сезоны включены; «Всё время» — таблица лучших за всё время, без кругов:
 * друзей и дивизионов за всё время сервер не считает.
 */
type RatingPeriod = "week" | "all";
const PERIOD_IDS: readonly RatingPeriod[] = ["week", "all"];

export function RatingScreen(): ReactNode {
  const board = useRuns((state) => state.leaderboards[RATED_DIFFICULTY_ID]);
  const pending = useRuns((state) => state.pending);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const notice = useSessionNotice();
  const restricted = useRestricted(RATING_RESTRICTION);
  const navigation = useNavigation();
  const { overview, receivedAt, reload } = useSeasonOverview();
  const [picked, setPicked] = useState<RatingPeriod | null>(null);
  const [circle, setCircle] = useState<RatingCircle>("all");
  const seasons = overview?.enabled === true ? overview : null;
  // Пока обзор не пришёл, периода нет: таблицу «Всё время» не грузим зря, а потом не перебиваем.
  const period: RatingPeriod | null = overview === null ? null : (picked ?? (seasons?.season != null ? "week" : "all"));
  // «Мой дивизион» — те же строки общей таблицы, отобранные клиентом: отдельного запроса нет.
  const week = useSeasonBoard(circle === "friends" ? "friends" : "all", period === "week" && seasons?.season != null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setFailure(null);
    // Неотправленные забеги сперва уходят на сервер: иначе игрок не нашёл
    // бы в таблице забег, который только что сыграл.
    await useRuns.getState().flush("screen");
    const problem = await useRuns.getState().loadLeaderboard(RATED_DIFFICULTY_ID);
    setFailure(problem);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (period === "all") void load();
  }, [period, load]);

  // «Ты» закреплено внизу экрана: цель на один забег всегда на виду.
  let footer: ReactNode = undefined;
  if (!restricted && period === "all" && board !== undefined) {
    footer = <YouStrip me={board.me} entries={board.entries} scoring={boardScoring(board.entries, board.me)} total={board.totalPlayers} />;
  } else if (!restricted && period === "week" && seasons !== null && week.state.status === "ready") {
    const weekly = week.state.board;
    footer = <YouStrip me={weekly.me} entries={weekly.entries} scoring={weekScoring(weekly, seasons)} total={weekly.total} />;
  }

  return (
    <Screen footer={footer}>
      <ContentColumn>
        <PageTitle>{t("rating.title")}</PageTitle>
        <p className="mb-3 text-sm text-text-muted">{t("rating.subtitle")}</p>

        {seasons === null ? null : <ClaimArea pending={seasons.pending} reload={reload} />}
        {seasons === null || period === null ? null : (
          <SegmentedControl
            track="rating_period"
            label={t("rating.periods")}
            items={PERIOD_IDS.map((id) => ({ id, label: t(`rating.period.${id}`) }))}
            activeId={period}
            onSelect={(id) => setPicked(id === "all" ? "all" : "week")}
          />
        )}

        {period === null ? <BoardSkeleton /> : null}
        {seasons !== null && period === "week" ? (
          <div className="mt-4">
            <SeasonTab
              circle={circle}
              onCircle={setCircle}
              data={seasons}
              receivedAt={receivedAt}
              reload={reload}
              restriction={RATING_RESTRICTION}
              board={week}
              list={(view) => <RatingList {...view} />}
              onInvite={() => navigation.resetTo("friends")}
            />
          </div>
        ) : null}

        {period === "all" ? (
          <>
            <div className="mt-4 grid grid-cols-1 gap-3" aria-busy={loading}>
              {/* Нет сессии — сказать почему; ошибка запроса лишь повторила бы то
                  же другими словами, а у блокировки ещё и потеряла бы причину. */}
              {notice !== null ? (
                <SessionNotice notice={notice} />
              ) : failure === null ? null : (
                <SyncProblem failure={failure} compact={board !== undefined} onRetry={() => void load()} />
              )}

              {board === undefined ? (
                loading ? <BoardSkeleton /> : null
              ) : (
                <>
                  {/* Под ограничением места нет, и «сыграйте забег» соврало бы — вместо него плашка. */}
                  <RestrictedPlaque kinds={RATING_RESTRICTION} />
                  {board.entries.length === 0 ? (
                    <p className="surface-sunken rounded-lg p-4 text-center text-sm text-text-muted">{t("rating.empty")}</p>
                  ) : (
                    <RatingList entries={board.entries} scoring={boardScoring(board.entries, board.me)} podium />
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

/** Таблица: пьедестал первых трёх и строки с четвёртой; без пьедестала — все строки подряд. */
function RatingList(props: BoardListView): ReactNode {
  const rows = props.podium ? props.entries.slice(3) : props.entries;
  return (
    <div className="grid grid-cols-1 gap-2">
      {props.podium ? <Podium entries={props.entries} scoring={props.scoring} /> : null}
      {rows.length === 0 ? null : (
        <ol className="grid grid-cols-1 gap-2">
          {rows.map((entry, index) => (
            <LeaderboardRow
              key={`${entry.rank}-${entry.name}`}
              entry={entry}
              index={index}
              scoring={props.scoring}
              {...(props.placeOf === undefined ? {} : { place: props.placeOf(entry) })}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * «Ты» внизу экрана: место, сколько очков до следующего места и дивизион.
 * Цель на один забег: сосед выше, пока он на экране, иначе ближайший из
 * показанных — с его местом в тексте. Нет забега — зов сыграть.
 */
export function YouStrip(props: { me: LeaderboardMe | null; entries: readonly LeaderboardEntry[]; scoring: Scoring; total: number }): ReactNode {
  const me = props.me;
  if (me === null) {
    return (
      <div className="surface-sunken flex items-center gap-3 rounded-lg p-3">
        <Trophy size={20} aria-hidden="true" className="shrink-0 text-text-muted" />
        <p className="text-sm text-text-muted">{t("rating.you.none")}</p>
      </div>
    );
  }

  const next = nextPlace(me, props.entries, props.scoring);
  const division = divisionId(me.division);
  const line =
    next.kind === "first"
      ? t("rating.you.first")
      : next.kind === "gap"
        ? next.unit === "points"
          ? t("rating.you.gap", { place: next.place, shown: formatNumber(next.gap), n: next.gap })
          : t("rating.you.gapTime", { place: next.place, time: formatDuration(next.gap) })
        : t("rating.you.plain");

  return (
    <div className="surface-card-selected flex items-center gap-3 rounded-lg p-3">
      <RankMark rank={me.rank} />
      <div className="min-w-0 flex-1">
        <p className="font-display text-sm font-bold text-text">
          {line}
          {division === null ? null : (
            <>
              {" · "}
              <DivisionWord division={division} />
            </>
          )}
        </p>
        <p className="text-xs text-text-muted">{t("rating.me.of", { total: props.total })}</p>
      </div>
    </div>
  );
}

/**
 * Строка таблицы. Главное число — то, по чему она ранжирована (очки, а в сезоне
 * по времени — время), чтобы порядок строк совпадал с видимым числом; время
 * забега при очках — подписью. `place` — место на экране, если оно не место на
 * доске (внутри дивизиона).
 */
export function LeaderboardRow(props: { entry: LeaderboardEntry; index: number; scoring?: Scoring; place?: number }): ReactNode {
  const { entry } = props;
  const place = props.place ?? entry.rank;
  const score = scoreOf(entry, props.scoring ?? "points");
  const style = styleAxis(entry.style);
  const runId = entryRunId(entry);

  return (
    <li
      className={[
        "relative flex animate-rise-in items-center gap-3 rounded-lg px-3 py-2.5",
        entry.isMe ? "surface-card-selected" : "surface-card",
      ].join(" ")}
      // Лесенка только у первых строк: пятидесятая строка, выезжающая через
      // две секунды, выглядит как тормоза.
      style={staggerStyle(Math.min(props.index, 8))}
    >
      <RankMark rank={place} />
      <Avatar name={entry.name} url={entry.photoUrl} size={36} />
      <div className="min-w-0 flex-1">
        {/* Метки не сжимаются, поэтому на узком экране уходят на вторую строку, а не выдавливают имя и не наезжают на время. */}
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-semibold text-text">
          {place === 1 ? <Crown size={14} aria-hidden="true" className="shrink-0 text-elite" /> : null}
          <span className="max-w-full truncate">{entry.name}</span>
          {entry.tester === true ? <TesterBadge /> : null}
          {entry.rubezh === true ? <RubezhMark /> : null}
          {entry.prestige !== undefined && entry.prestige > 0 ? <PrestigeMark points={entry.prestige} /> : null}
          {entry.isMe ? (
            <span className="shrink-0">
              <Badge tone="accent">{t("rating.you")}</Badge>
            </span>
          ) : null}
        </p>
        <div className="flex min-w-0 items-center gap-1.5">
          {style === null ? null : <StyleBadge axis={style} />}
          <RatingMeta weaponId={entry.startingWeaponId} level={entry.level} kills={entry.enemiesKilled} />
        </div>
      </div>
      <ScoreCell score={score} />
      {runId === null ? null : <RowOpener runId={runId} name={entry.name} />}
    </li>
  );
}

/** Главное число строки крупно и моноширинно: столбец читается сверху вниз; время забега — мелко под очками. */
function ScoreCell(props: { score: ReturnType<typeof scoreOf> }): ReactNode {
  const { score } = props;
  return (
    <span className="shrink-0 text-right">
      <span aria-hidden={score.kind === "points" ? "true" : undefined} className="block font-display text-base font-bold tabular-nums text-text">
        {score.kind === "points" ? formatNumber(score.value) : formatDuration(score.value)}
      </span>
      {score.kind === "points" ? <span className="sr-only">{t("rating.points.sr", { points: formatNumber(score.value) })}</span> : null}
      {score.sub === null ? null : <span className="block text-xs tabular-nums text-text-muted">{formatDuration(score.sub)}</span>}
    </span>
  );
}

/**
 * Значок «Рубеж взят» (T-0124): у аккаунта засчитана победа над стражем. Тон
 * элиты, как у стража на экране смерти; не сжимается, как и остальные метки.
 * Подсказка — для наведения, скринридеру — слова, значок сам ему ничего не говорит.
 */
function RubezhMark(): ReactNode {
  return (
    <span title={t("rating.rubezh.hint")} className="inline-flex shrink-0 items-center rounded-sm bg-elite/15 p-0.5 text-elite ring-1 ring-elite/40">
      <ShieldCheck size={12} aria-hidden="true" />
      <span className="sr-only">{t("rating.rubezh.label")}</span>
    </span>
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
