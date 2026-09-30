import type { ReactNode } from "react";
import { Bell, BookOpen, History, Info, MessageSquareWarning, Newspaper, Settings } from "lucide-react";
import { Avatar, Button, ListGroup, ListItem, Modal } from "../design-system/components";
import { t } from "../i18n";
import { badgeText, useBadges } from "../state/badges";
import { useNavigation, type ScreenId } from "../state/navigation";
import { useProgress } from "../state/progress";
import { useSettings } from "../state/settings";
import { useShell } from "../state/shell";

/**
 * Общее меню из шапки: всё, что не раздел нижней панели
 * (docs/27-design-system-and-app-shell.md §6, docs/35-stage4-plan.md Р60).
 * Первой строкой — профиль с именем и уровнем: в шапке имени нет. Дальше —
 * уведомления и история имущества: на узком экране колокольчика в шапке нет,
 * а важное не прячется глубже одного касания.
 */
export function MainMenu(props: { onClose(): void }): ReactNode {
  const settings = useSettings();
  const supportsFullscreen = useShell((state) => state.adapter.ui.supportsFullscreen);
  const user = useShell((state) => state.adapter.displayUser);
  const name = user?.displayName ?? t("profile.guest");
  const level = useProgress((state) => state.progress?.level ?? state.runLevel);
  const unread = useBadges((state) => state.notifications);
  const freshVersions = useBadges((state) => state.changelog);
  const withAccount = useShell((state) => state.capabilities.auth !== undefined);

  const open = (screen: ScreenId): void => {
    props.onClose();
    useNavigation.getState().push(screen);
  };

  return (
    <Modal
      title={t("menu.title")}
      placement="bottom"
      onDismiss={props.onClose}
      footer={
        <Button variant="ghost" block onClick={props.onClose}>
          {t("app.close")}
        </Button>
      }
    >
      <ListGroup>
        <ListItem
          icon={<Avatar name={name} url={user?.avatarUrl} size={36} />}
          bareIcon
          title={name}
          hint={level === null ? t("profile.title") : t("header.level", { level })}
          onClick={() => open("profile")}
        />
        {withAccount ? (
          <>
            <ListItem
              icon={<Bell size={18} />}
              title={t("menu.notifications")}
              {...(badgeText(unread) === undefined ? {} : { badge: badgeText(unread) })}
              onClick={() => open("notifications")}
            />
            <ListItem icon={<History size={18} />} title={t("menu.history")} onClick={() => open("history")} />
          </>
        ) : null}
      </ListGroup>

      <div className="mt-3">
        <ListGroup>
          {withAccount ? (
            <ListItem
              icon={<Newspaper size={18} />}
              title={t("menu.changelog")}
              {...(badgeText(freshVersions) === undefined ? {} : { badge: badgeText(freshVersions) })}
              onClick={() => open("changelog")}
            />
          ) : null}
          <ListItem icon={<BookOpen size={18} />} title={t("guide.title")} hint={t("guide.menu.hint")} onClick={() => open("guide")} />
          <ListItem icon={<Settings size={18} />} title={t("settings.title")} onClick={() => open("settings")} />
        </ListGroup>
      </div>

      <div className="mt-3">
        <ListGroup>
          <ListItem
            title={t("settings.fullscreen")}
            hint={supportsFullscreen ? undefined : t("settings.fullscreen.unsupported")}
            toggle={{
              checked: settings.screenMode === "fullscreen",
              disabled: !supportsFullscreen,
              onChange: () => {
                void settings.setScreenMode(settings.screenMode === "fullscreen" ? "normal" : "fullscreen");
              },
            }}
          />
        </ListGroup>
      </div>

      <div className="mt-3">
        <ListGroup>
          <ListItem
            icon={<MessageSquareWarning size={18} />}
            title={t("settings.testers")}
            onClick={() => open("testers")}
          />
          <ListItem icon={<Info size={18} />} title={t("settings.about")} onClick={() => open("about")} />
        </ListGroup>
      </div>
    </Modal>
  );
}
