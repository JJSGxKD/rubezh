import type { ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { t } from "../../i18n";
import { useSettings } from "../../state/settings";
import { useShell } from "../../state/shell";
import { IconButton } from "./Button";

/**
 * Быстрый переключатель полноэкранного режима.
 *
 * Настройка живёт в «Настройках» (docs/27-design-system-and-app-shell.md
 * §5.2.1), но лезть туда посреди забега незачем: режим экрана — это то, что
 * игрок меняет на ходу, а не настраивает один раз. Кнопка стоит там же, где
 * он о ней вспоминает: в лобби и на паузе.
 *
 * Там, где клиент полноэкранный режим не умеет, кнопка неактивна, а не
 * отсутствует: исчезающие элементы интерфейса читаются как сбой.
 */
export function FullscreenButton(): ReactNode {
  const screenMode = useSettings((state) => state.screenMode);
  const supported = useShell((state) => state.adapter.ui.supportsFullscreen);
  const fullscreen = screenMode === "fullscreen";

  return (
    <IconButton
      label={supported ? t("settings.fullscreen") : t("settings.fullscreen.unsupported")}
      disabled={!supported}
      onClick={() => {
        void useSettings.getState().setScreenMode(fullscreen ? "normal" : "fullscreen");
      }}
    >
      {fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
    </IconButton>
  );
}
