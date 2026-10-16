import { useState, type ReactNode } from "react";
import { BellRing } from "lucide-react";
import { Button, Card } from "../design-system/components";
import { t } from "../i18n";
import "../i18n/home";
import { dismissBotAccess, requestBotAccess } from "../state/bot-access-sync";

/**
 * Карточка «Разрешить сообщения от бота» на главной после первого забега
 * (tasks/T-0010): с чанком главной, первой загрузке она не нужна. Когда её
 * показывать, решает `shouldOfferBotAccess` — карточка только рисует и
 * отвечает на нажатия. Отзыв в это время не показывается, две просьбы подряд
 * — это уже навязчиво (`home.tsx`).
 */
export function HomeBotAccess(): ReactNode {
  const [asking, setAsking] = useState(false);

  const allow = (): void => {
    setAsking(true);
    void requestBotAccess("lobby").finally(() => setAsking(false));
  };

  return (
    <div className="mt-3">
      <Card appearIndex={5} stripe="accent">
        <div className="flex items-start gap-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
            <BellRing size={22} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-sm font-bold text-text">{t("home.botAccess.title")}</span>
            <span className="mt-0.5 block text-xs text-text-muted">{t("home.botAccess.text")}</span>
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="m" block loading={asking} onClick={allow}>
            {t("home.botAccess.allow")}
          </Button>
          <Button size="m" block variant="ghost" disabled={asking} onClick={() => dismissBotAccess()}>
            {t("home.botAccess.later")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
