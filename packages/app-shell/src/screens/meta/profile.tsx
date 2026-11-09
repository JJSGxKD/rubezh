import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { RecentRun } from "@bh/shared-types";
import {
  Avatar,
  Badge,
  Button,
  Card,
  ContentColumn,
  Screen,
  SectionTitle,
  Stat,
  StubNotice,
} from "../../design-system/components";
import { formatDuration, formatNumber, t } from "../../i18n";
import { historyDifficultyKey, RATED_DIFFICULTY_ID } from "../../state/difficulty";
import { useMeta } from "../../state/meta";
import { useNavigation } from "../../state/navigation";
import type { ApiFailure } from "../../state/api-request";
import { useProgress } from "../../state/progress";
import { useRuns } from "../../state/runs";
import { useSession } from "../../state/session";
import { useShell } from "../../state/shell";
import { createAchievementsApi, type AchievementsSummary } from "../../state/achievements-api";
import { ItemIcon } from "../item-icons";
import { achievementTitle, CategoryIcon } from "./achievement-card";
import { AccountLevel } from "./account-level";
import { RestrictionsSection } from "./restricted-plaque";
import { DonateBlock } from "./donate-block";
import { RunDetailSheet } from "./run-detail";
import { SupporterBadge } from "./supporter-badge";

export { HistoryScreen } from "./history";
export { LevelScreen } from "./level";
import { SessionNotice, useSessionNotice } from "./session-notice";
import { SurvivalTime, SyncProblem } from "./sync-ui";
import { TesterBadge } from "./tester-badge";

/**
 * Профиль игрока: аккаунт, счётчики и рекорды с сервера, последние забеги
 * (docs/34-stage3-plan.md, WP7).
 *
 * Имя, аватар и дата — из аккаунта на сервере: профиль совпадает с тем, что
 * в базе. Сессии нет — имя из параметров запуска площадки, только для
 * отображения (docs/08-web-and-identity.md §4), и профиль собирается из того,
 * что знает устройство, честно говоря, почему это не всё (`session-notice.tsx`).
 */
export function ProfileScreen(): ReactNode {
  const navigation = useNavigation();
  const user = useShell((state) => state.adapter.displayUser);
  const profile = useRuns((state) => state.profile);
  const progress = useProgress((state) => state.progress);
  const pending = useRuns((state) => state.pending);
  const local = useMeta();
  // Рекорд один — по единой сложности. Рекорд устройства может оказаться
  // больше серверного: забег ещё в очереди или сыгран до плейтеста. Игроку
  // показываем лучший.
  const bestServer = profile?.best[RATED_DIFFICULTY_ID] ?? null;
  const bestSeconds = Math.max(bestServer?.survivalSec ?? 0, local.best[RATED_DIFFICULTY_ID]);
  const account = useSession((state) => state.account);
  const status = useSession((state) => state.status);
  const notice = useSessionNotice();
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setFailure(null);
    await useRuns.getState().flush("screen");
    const [runs] = await Promise.all([
      useRuns.getState().loadProfile(),
      // Запрос уровня — отдельным чанком, как и сам вопрос о награде.
      import("../../state/progress-api").then(({ loadProgress }) => loadProgress()),
    ]);
    setFailure(runs);
  };

  // Вход наладился — после повтора или уже открытого экрана — профиль
  // загружается заново: иначе игрок смотрел бы на пустоту до следующего захода.
  useEffect(() => {
    void load();
  }, [status === "ready"]);

  const name = account?.displayName ?? user?.displayName ?? t("profile.guest");
  const avatar = account === null ? user?.avatarUrl : account.photoUrl;

  return (
    <Screen title={t("profile.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <Card>
          <div className="flex items-center gap-3">
            <Avatar name={name} url={avatar ?? null} size={56} />
            <div className="min-w-0">
              <p className="truncate font-display text-lg font-bold text-text">{name}</p>
              {/* Знаки — строкой под именем и переносятся: два со словом рядом с именем на 320 px съели бы его. */}
              {account?.tester === true || account?.supporter === true ? (
                <p className="mt-1 mb-1 flex flex-wrap items-center gap-1.5">
                  {account.tester === true ? <TesterBadge size="l" /> : null}
                  {account.supporter === true ? <SupporterBadge size="l" /> : null}
                </p>
              ) : null}
              <p className="text-xs text-text-muted">
                {account === null ? t("profile.local") : t("profile.since", { date: formatSince(account.createdAt) })}
              </p>
            </div>
          </div>
          <div className="surface-sunken mt-4 grid grid-cols-3 gap-3 rounded-lg p-3">
            <Stat label={t("profile.runs")} value={formatNumber(profile?.runs ?? local.runs)} />
            <Stat label={t("profile.kills")} value={profile === null ? "—" : formatNumber(profile.totalKills)} />
            <Stat
              label={t("profile.timePlayed")}
              value={profile === null ? "—" : formatPlayTime(profile.totalSurvivalSec)}
            />
          </div>
          {progress === null ? null : (
            <>
              <AccountLevel progress={progress} />
              <div className="mt-3">
                <Button track="open_level" variant="secondary" block onClick={() => navigation.push("level")}>
                  {t("profile.level.more")}
                </Button>
                <Button track="open_history" variant="ghost" block onClick={() => navigation.push("history")}>
                  {t("profile.history")}
                </Button>
              </div>
            </>
          )}
        </Card>

        {notice !== null ? (
          <div className="mt-3">
            <SessionNotice notice={notice} />
          </div>
        ) : failure === null ? null : (
          <div className="mt-3">
            <SyncProblem failure={failure} compact onRetry={() => void load()} />
          </div>
        )}
        {pending > 0 ? (
          <p className="mt-2 text-center text-xs text-text-muted">{t("rating.pending", { count: pending })}</p>
        ) : null}

        {account === null ? null : <ProfileAchievements />}

        {/* Закрытое — до рекордов: «нет места» в них объясняет именно оно. */}
        {account === null ? null : <RestrictionsSection />}

        <SectionTitle>{t("profile.best")}</SectionTitle>
        <div className="surface-card flex items-center gap-3 rounded-lg px-3 py-2.5">
          <span className="min-w-0 flex-1 text-sm text-text-muted">
            {bestServer === null ? t("profile.best.noRank") : t("profile.best.rank", { rank: bestServer.rank })}
          </span>
          {bestSeconds > 0 ? <SurvivalTime seconds={bestSeconds} /> : <span className="font-display text-base text-text-muted">—</span>}
        </div>

        <SectionTitle>{t("profile.recent")}</SectionTitle>
        {profile === null || profile.recent.length === 0 ? (
          <p className="surface-sunken rounded-lg p-4 text-center text-sm text-text-muted">
            {profile === null ? t("profile.recent.unknown") : t("profile.recent.empty")}
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2">
            {profile.recent.map((run) => (
              <RecentRunRow
                key={`${run.at}-${run.survivalSec}`}
                run={run}
                // Сервер до листа забега id не отдавал — такая строка просто не открывается.
                onOpen={run.runId === undefined ? undefined : () => setOpenRun(run.runId ?? null)}
              />
            ))}
          </ul>
        )}

        {/* Поддержать проект — ниже последних забегов, выше заглушки «Скоро»; способов нет — блока нет. */}
        {account === null ? null : <DonateBlock place="profile" />}

        <SectionTitle>{t("profile.later")}</SectionTitle>
        <StubNotice text={t("profile.soon")} />
      </ContentColumn>
      {openRun === null ? null : <RunDetailSheet runId={openRun} onClose={() => setOpenRun(null)} />}
    </Screen>
  );
}

/**
 * Престиж и три любимых достижения (T-0107). Сводку просит сам блок: сбой её
 * загрузки блок скрывает, профиль от этого не ломается. Нет любимых — строки
 * с ними нет.
 */
function ProfileAchievements(): ReactNode {
  const [summary, setSummary] = useState<AchievementsSummary | null>(null);

  useEffect(() => {
    let alive = true;
    void createAchievementsApi()
      .summary()
      .then((response) => {
        if (alive && response.ok) setSummary(response.data);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (summary === null) return null;
  return (
    <div className="mt-3">
      <Card>
        <p className="font-display text-base font-bold text-accent">{t("profile.prestige", { points: formatNumber(summary.prestige) })}</p>
        {summary.favorites.length === 0 ? null : (
          <>
            <SectionTitle as="h3" spacing="mt-3 mb-2">
              {t("profile.favorites")}
            </SectionTitle>
            <ul className="grid gap-2">
              {summary.favorites.map((item) => (
                <li key={item.id} className="surface-sunken flex items-center gap-2 rounded-lg px-3 py-2 text-accent">
                  <CategoryIcon category={item.category} size={18} />
                  <span className="min-w-0 truncate text-sm text-text">{achievementTitle(item)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

function RecentRunRow(props: { run: RecentRun; onOpen?: (() => void) | undefined }): ReactNode {
  const { run } = props;
  // Плашка только у забегов не на единой сложности: «Обучение» и «Нормальная».
  const difficultyKey = historyDifficultyKey(run.difficultyId);
  const body = (
    <>
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-weapon/15 text-weapon">
        <ItemIcon kind="weapon" id={run.startingWeaponId} size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm text-text">{t(`weapon.${run.startingWeaponId}.name`)}</span>
          {difficultyKey === null ? null : <Badge>{t(difficultyKey)}</Badge>}
        </span>
        <span className="block text-xs text-text-muted">
          {t("profile.recent.meta", { level: run.level, date: formatWhen(run.at) })}
        </span>
      </span>
      <span className="font-display text-sm font-bold tabular-nums text-text">{formatDuration(run.survivalSec)}</span>
      {props.onOpen === undefined ? null : <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-text-muted" />}
    </>
  );
  if (props.onOpen === undefined) return <li className="surface-card flex items-center gap-3 rounded-lg px-3 py-2.5">{body}</li>;
  return (
    <li>
      <button
        type="button"
        aria-label={t("profile.recent.open", { date: formatWhen(run.at) })}
        onClick={props.onOpen}
        className="surface-card flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-transform duration-(--duration-fast) ease-base active:scale-[0.98]"
      >
        {body}
      </button>
    </li>
  );
}

const SINCE_FORMAT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });

/** С какого дня игрок с нами — по дате аккаунта на сервере. */
function formatSince(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? "—" : SINCE_FORMAT.format(date);
}

const WHEN_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Когда сыгран забег — в местном времени игрока: сервер хранит UTC. */
function formatWhen(atMs: number): string {
  return WHEN_FORMAT.format(new Date(atMs));
}

/** Суммарное время: до часа — «минуты:секунды», дальше — часы и минуты. */
function formatPlayTime(seconds: number): string {
  if (seconds < 3600) return formatDuration(seconds);
  const hours = Math.floor(seconds / 3600);
  return t("time.hoursMinutes", { hours, minutes: Math.floor((seconds % 3600) / 60) });
}
