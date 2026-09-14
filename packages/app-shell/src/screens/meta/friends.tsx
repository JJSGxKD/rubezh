import { useState, type ReactNode } from "react";
import { Check, Gamepad2, UserPlus, Users } from "lucide-react";
import {
  Button,
  Card,
  ContentColumn,
  IconEmblem,
  PageTitle,
  Screen,
  SectionTitle,
  StubNotice,
} from "../../design-system/components";
import { t } from "../../i18n";
import { track, useShell } from "../../state/shell";

/**
 * «Друзья» на время плейтеста: одна рабочая кнопка — позвать друга в игру.
 *
 * Награды за приглашение нет, и приглашённый не привязывается к пригласившему:
 * данные плейтеста стираются, а реферальная программа с привязкой и
 * наградами — отдельная система после авторизации
 * (docs/23-referral-and-partner-program.md). Экран говорит об этом прямо,
 * чтобы тестер не ждал бонуса.
 */
const INVITE_START_PARAM = "invite";

type InviteState = "idle" | "shared" | "copied" | "unavailable";

export function FriendsScreen(): ReactNode {
  const botUrl = useShell((state) => state.capabilities.botUrl);
  const [state, setState] = useState<InviteState>("idle");
  const [busy, setBusy] = useState(false);
  const inviteUrl = botUrl === "" ? "" : `${botUrl}?startapp=${INVITE_START_PARAM}`;

  const invite = async (): Promise<void> => {
    if (inviteUrl === "" || busy) return;
    setBusy(true);
    track("share_offered", { context: "friends_invite" });
    const result = await useShell.getState().adapter.invite({ url: inviteUrl, text: t("friends.invite.text") });
    track("share_completed", { context: "friends_invite", result });
    setState(result);
    setBusy(false);
  };

  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("friends.title")}</PageTitle>

        <div className="mt-4 flex flex-col items-center gap-3 text-center">
          <IconEmblem size="l">
            <UserPlus size={36} />
          </IconEmblem>
          <h2 className="font-display text-xl font-bold text-text">{t("friends.invite.title")}</h2>
          <p className="max-w-[320px] text-sm text-text-muted">{t("friends.invite.body")}</p>
        </div>

        <div className="mt-5 grid gap-2">
          <Button size="l" block glow disabled={inviteUrl === ""} loading={busy} onClick={() => void invite()}>
            <UserPlus size={20} aria-hidden="true" />
            {t("friends.invite.action")}
          </Button>
          <p role="status" className="min-h-5 text-center text-xs text-text-muted">
            {inviteUrl === "" ? t("friends.invite.noBot") : state === "idle" ? "" : t(`friends.invite.${state}`)}
          </p>
        </div>

        <Card>
          <ul className="grid gap-2 text-sm text-text-muted">
            <li className="flex items-start gap-2">
              <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
              {t("friends.invite.point.free")}
            </li>
            <li className="flex items-start gap-2">
              <Gamepad2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-info" />
              {t("friends.invite.point.noReward")}
            </li>
            <li className="flex items-start gap-2">
              <Users size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
              {t("friends.invite.point.wipe")}
            </li>
          </ul>
        </Card>

        <SectionTitle>{t("friends.later")}</SectionTitle>
        <StubNotice text={t("friends.soon")} />
      </ContentColumn>
    </Screen>
  );
}
