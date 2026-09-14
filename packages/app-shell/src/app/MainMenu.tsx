import type { ReactNode } from "react";
import { BookOpen, Info, MessageSquareWarning, Settings, UserRound } from "lucide-react";
import { Button, ListGroup, ListItem, Modal } from "../design-system/components";
import { t } from "../i18n";
import { useNavigation, type ScreenId } from "../state/navigation";
import { useSettings } from "../state/settings";
import { useShell } from "../state/shell";

/**
 * Общее меню из шапки: всё, что не раздел нижней панели. Одна кнопка вместо
 * ряда значков — шапке нужно место под имя и валюты
 * (docs/27-design-system-and-app-shell.md §6).
 */
export function MainMenu(props: { onClose(): void }): ReactNode {
  const settings = useSettings();
  const supportsFullscreen = useShell((state) => state.adapter.ui.supportsFullscreen);

  const open = (screen: ScreenId): void => {
    props.onClose();
    useNavigation.getState().push(screen);
  };

  return (
    <Modal
      title={t("menu.title")}
      placement="bottom"
      footer={
        <Button variant="ghost" block onClick={props.onClose}>
          {t("app.close")}
        </Button>
      }
    >
      <ListGroup>
        <ListItem icon={<UserRound size={18} />} title={t("profile.title")} onClick={() => open("profile")} />
        <ListItem
          icon={<BookOpen size={18} />}
          title={t("guide.title")}
          hint={t("guide.menu.hint")}
          onClick={() => open("guide")}
        />
        <ListItem icon={<Settings size={18} />} title={t("settings.title")} onClick={() => open("settings")} />
      </ListGroup>

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
