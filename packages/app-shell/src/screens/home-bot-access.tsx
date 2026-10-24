import { useState, type ReactNode } from "react";
import { BellRing } from "lucide-react";
import { z } from "zod/mini";
import { Button, Card } from "../design-system/components";
import { t } from "../i18n";
import "../i18n/home";
import { apiRequest, type ApiRequest, type ApiResult } from "../state/api-request";
import { BOT_ACCESS_ASKS_KEY, NO_ASKS, useBotAccess, type BotAccessPlace, type BotAccessResult } from "../state/bot-access";
import { createPersistedValue } from "../state/persisted";
import { reportError, track, useShell } from "../state/shell";

/**
 * Чтение и запись разрешения боту писать (tasks/T-0010): счёт просьб на
 * устройстве, ответ сервера, системное окно площадки. Живут рядом с карточкой
 * — чанком главной, а настройки берут их отсюда же; состояние и правило
 * показа — `state/bot-access.ts`, оно едет с первой загрузкой.
 */

const asksSchema = z.object({ count: z.number(), lastAt: z.nullable(z.number()) });
const viewSchema = z.object({ canMessage: z.boolean() });

const persisted = () =>
  createPersistedValue({
    storage: useShell.getState().storage,
    key: BOT_ACCESS_ASKS_KEY,
    schema: asksSchema,
    fallback: NO_ASKS,
    onBroken: (key, reason) => reportError("bot-access", `${key}: ${reason}`),
  });

/** Прочитать счёт показов с устройства — при запуске. */
export function hydrateBotAccess(): void {
  useBotAccess.setState({ asks: persisted().read() });
}

export interface BotAccessApi {
  mine(): Promise<ApiResult<{ canMessage: boolean }>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createBotAccessApi(request: ApiRequest = apiRequest): BotAccessApi {
  return { mine: () => request("/api/v1/me/messaging", viewSchema, { method: "GET" }) };
}

/** Спросить сервер; не ответил — остаётся прежнее («не знаем» или последний ответ). */
export async function loadBotAccess(api?: BotAccessApi): Promise<void> {
  if (api === undefined && useShell.getState().capabilities.auth === undefined) return;
  const response = await (api ?? createBotAccessApi()).mine();
  if (response.ok) useBotAccess.setState({ canMessage: response.data.canMessage });
}

function countAsk(now: number): void {
  const asks = { count: useBotAccess.getState().asks.count + 1, lastAt: now };
  useBotAccess.setState({ asks });
  persisted().write(asks);
}

/**
 * Показать системное окно. «Разрешить» — разрешение считается полученным
 * сразу; отказ, закрытое окно и тишина — счёт +1: просьбу показали, и
 * считать её нужно так же, как «Не сейчас».
 */
export async function requestBotAccess(place: BotAccessPlace, now = Date.now()): Promise<BotAccessResult> {
  const request = useShell.getState().adapter?.requestBotMessages;
  if (request === undefined) return "unavailable";
  track("bot_access_offered", { place });
  let result: BotAccessResult;
  try {
    result = await request.call(useShell.getState().adapter);
  } catch (error: unknown) {
    reportError("bot-access", error instanceof Error ? error.message : "запрос разрешения не удался");
    result = "unavailable";
  }
  track("bot_access_result", { place, result });
  if (result === "allowed") useBotAccess.setState({ canMessage: true });
  else if (result === "declined") countAsk(now);
  return result;
}

/** «Не сейчас» — просьбу показали и отложили; площадку не зовём. */
export function dismissBotAccess(now = Date.now()): void {
  countAsk(now);
}

/**
 * Карточка «Разрешить сообщения от бота' на главной после первого забега
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
          <Button track="allow" size="m" block loading={asking} onClick={allow}>
            {t("home.botAccess.allow")}
          </Button>
          <Button track="later" size="m" block variant="ghost" disabled={asking} onClick={() => dismissBotAccess()}>
            {t("home.botAccess.later")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
