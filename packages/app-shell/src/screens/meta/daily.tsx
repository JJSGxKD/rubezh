import type { ReactNode } from "react";
import { CalendarCheck } from "lucide-react";
import {
  Button,
  ContentColumn,
  IconEmblem,
  Screen,
  StubNotice,
  staggerStyle,
} from "../../design-system/components";
import { t } from "../../i18n";
import { useNavigation } from "../../state/navigation";
import { RewardIcon, rewardAmount, rewardLabel, rewardTone } from "./reward";
import { DAILY_REWARDS } from "./stub-content";

/**
 * Награда дня: календарь из семи дней, седьмой крупнее
 * (docs/27-design-system-and-app-shell.md §6).
 *
 * Заглушка: подсвечен первый день, «Забрать» недоступна. Какой день сегодня и
 * что уже забрано, будет решать сервер — по часам устройства награду
 * получали бы переводом времени (docs/07-monetization-and-ads.md §7).
 */
const TODAY_INDEX = 0;

export function DailyScreen(): ReactNode {
  const navigation = useNavigation();

  return (
    <Screen
      title={t("daily.title")}
      onBack={() => navigation.pop()}
      footer={
        <Button size="l" block disabled>
          {t("daily.claim")}
        </Button>
      }
    >
      <ContentColumn>
        <div className="mt-4 mb-5 flex flex-col items-center gap-3 text-center landscape:hidden">
          <IconEmblem size="l">
            <CalendarCheck size={36} />
          </IconEmblem>
          <p className="max-w-[300px] text-sm text-text-muted">{t("daily.text")}</p>
        </div>

        <StubNotice text={t("reward.stub")} />

        <ol className="mt-4 grid grid-cols-4 gap-2 landscape:grid-cols-7">
          {DAILY_REWARDS.map((reward, index) => {
            const today = index === TODAY_INDEX;
            const last = index === DAILY_REWARDS.length - 1;
            return (
              <li
                key={index}
                aria-current={today ? "date" : undefined}
                aria-label={`${t("daily.day", { day: index + 1 })}: ${rewardLabel(reward)}`}
                style={staggerStyle(index)}
                className={[
                  "relative flex animate-rise-in flex-col items-center justify-between gap-2 overflow-hidden rounded-lg px-1 py-3 text-center",
                  today ? "surface-card-selected" : "surface-card",
                  last ? "col-span-2 landscape:col-span-1" : "",
                ].join(" ")}
              >
                <span
                  className={[
                    "font-display text-xs font-semibold tracking-wide uppercase",
                    today ? "text-accent" : "text-text-muted",
                  ].join(" ")}
                >
                  {today ? t("daily.today") : t("daily.day", { day: index + 1 })}
                </span>
                <span
                  aria-hidden="true"
                  className={`inline-flex items-center justify-center rounded-md ${last ? "size-14" : "size-11"} ${rewardTone(reward.kind)}`}
                >
                  <RewardIcon kind={reward.kind} size={last ? 30 : 22} />
                </span>
                <span
                  aria-hidden="true"
                  className="min-h-5 font-display text-sm font-bold tabular-nums text-text"
                >
                  {reward.kind === "skin" ? t("reward.skin.short") : rewardAmount(reward)}
                </span>
              </li>
            );
          })}
        </ol>
      </ContentColumn>
    </Screen>
  );
}
