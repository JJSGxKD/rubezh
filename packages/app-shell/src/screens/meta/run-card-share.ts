import type { InvitePayload, InviteResult } from "@bh/shared-types";
import { formatNumber, t } from "../../i18n";
import "../../i18n/run-card";
import type { AnalyticsEvent, AnalyticsPayload } from "../../state/analytics";
import { useShell, track } from "../../state/shell";
import { runCardShareUrl } from "./run-card-rules";

/**
 * «Поделиться» на карточке забега (tasks/T-0297, docs/24 §7): площадка
 * открывает выбор чата со ссылкой `?startapp=run-<id>`, по ней у получателя
 * при запуске открывается эта же карточка. Карточка рейтинговая и без
 * персональных данных, поэтому делиться можно любой.
 */

export interface RunCardShareDeps {
  botUrl: string;
  invite(payload: InvitePayload): Promise<InviteResult>;
  track(event: AnalyticsEvent, payload: AnalyticsPayload): void;
}

/** Строка под кнопкой, если из выбора чата не всё видно и так; отмена и успех — молчание. */
export async function shareRunCard(card: { runId: string; points: number }, deps: RunCardShareDeps = defaultDeps()): Promise<string | null> {
  if (deps.botUrl === "") return t("runCard.share.noBot");
  deps.track("share_offered", { context: "run_card", method: "link" });
  const result = await deps.invite({
    url: runCardShareUrl(deps.botUrl, card.runId),
    text: t("runCard.share.text", { points: formatNumber(card.points) }),
  });
  deps.track("share_completed", { context: "run_card", method: "link", result });
  if (result === "copied") return t("runCard.share.copied");
  return result === "unavailable" ? t("runCard.share.unavailable") : null;
}

function defaultDeps(): RunCardShareDeps {
  const { adapter, capabilities } = useShell.getState();
  return { botUrl: capabilities.botUrl, invite: (payload) => adapter.invite(payload), track };
}
