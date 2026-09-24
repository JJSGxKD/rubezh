import { useEffect, useState, type ReactNode } from "react";
import { DIFFICULTY_IDS, type RecentRun } from "@bh/shared-types";
import {
  Avatar,
  Badge,
  Card,
  ContentColumn,
  Screen,
  SectionTitle,
  Stat,
  StubNotice,
} from "../../design-system/components";
import { formatDuration, formatNumber, t } from "../../i18n";
import { useMeta } from "../../state/meta";
import { useNavigation } from "../../state/navigation";
import type { ApiFailure } from "../../state/api-request";
import { useRuns } from "../../state/runs";
import { useSession } from "../../state/session";
import { useShell } from "../../state/shell";
import { ItemIcon } from "../item-icons";
import { SessionNotice, useSessionNotice } from "./session-notice";
import { SurvivalTime, SyncProblem } from "./sync-ui";

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
  const pending = useRuns((state) => state.pending);
  const local = useMeta();
  const account = useSession((state) => state.account);
  const status = useSession((state) => state.status);
  const notice = useSessionNotice();
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const load = async (): Promise<void> => {
    setFailure(null);
    await useRuns.getState().flush("screen");
    setFailure(await useRuns.getState().loadProfile());
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

        <SectionTitle>{t("profile.best")}</SectionTitle>
        <ul className="grid grid-cols-1 gap-2">
          {DIFFICULTY_IDS.map((id) => {
            const server = profile?.best[id] ?? null;
            // Рекорд устройства может оказаться больше серверного: забег ещё в
            // очереди или сыгран до плейтеста. Игроку показываем лучший.
            const seconds = Math.max(server?.survivalSec ?? 0, local.best[id]);
            return (
              <li key={id} className="surface-card flex items-center gap-3 rounded-lg px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block font-display text-sm font-semibold text-text">
                    {t(`difficulty.${id}.name`)}
                  </span>
                  <span className="block text-xs text-text-muted">
                    {server === null ? t("profile.best.noRank") : t("profile.best.rank", { rank: server.rank })}
                  </span>
                </span>
                {seconds > 0 ? (
                  <SurvivalTime seconds={seconds} />
                ) : (
                  <span className="font-display text-base text-text-disabled">—</span>
                )}
              </li>
            );
          })}
        </ul>

        <SectionTitle>{t("profile.recent")}</SectionTitle>
        {profile === null || profile.recent.length === 0 ? (
          <p className="surface-sunken rounded-lg p-4 text-center text-sm text-text-muted">
            {profile === null ? t("profile.recent.unknown") : t("profile.recent.empty")}
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2">
            {profile.recent.map((run) => (
              <RecentRunRow key={`${run.at}-${run.survivalSec}`} run={run} />
            ))}
          </ul>
        )}

        <SectionTitle>{t("profile.later")}</SectionTitle>
        <StubNotice text={t("profile.soon")} />
      </ContentColumn>
    </Screen>
  );
}

function RecentRunRow(props: { run: RecentRun }): ReactNode {
  const { run } = props;
  return (
    <li className="surface-card flex items-center gap-3 rounded-lg px-3 py-2.5">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-weapon/15 text-weapon">
        <ItemIcon kind="weapon" id={run.startingWeaponId} size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm text-text">{t(`weapon.${run.startingWeaponId}.name`)}</span>
          <Badge>{t(`difficulty.${run.difficultyId}.name`)}</Badge>
        </span>
        <span className="block text-xs text-text-muted">
          {t("profile.recent.meta", { level: run.level, date: formatWhen(run.at) })}
        </span>
      </span>
      <span className="font-display text-sm font-bold tabular-nums text-text">{formatDuration(run.survivalSec)}</span>
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
