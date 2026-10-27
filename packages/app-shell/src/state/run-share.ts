import type { InvitePayload, InviteResult } from "@bh/shared-types";
import { formatDuration, t } from "../i18n";
import "../i18n/run-share";
import { createFriendsApi, friendInviteUrl, friendsAvailable } from "./friends-api";
import { track, useShell } from "./shell";
import type { AnalyticsEvent, AnalyticsPayload } from "./analytics";

/**
 * «Поделиться» на экране итогов — до своей карточки результата
 * (docs/24-attribution-and-sharing.md §7): итог уходит путём приглашения
 * друга — выбор чата со ссылкой и строкой о забеге. Ссылка — дружбы, когда
 * есть вход: позванный по итогу засчитывается так же, как позванный из
 * «Друзей». Модуль грузится по нажатию: чанк забега на пределе бюджета.
 */

export interface RunShareInput {
  survivalSec: number;
  record: boolean;
}

export interface RunShareDeps {
  botUrl: string;
  withAccount: boolean;
  /** параметр запуска ссылки дружбы; null — ссылки нет */
  link(): Promise<string | null>;
  invite(payload: InvitePayload): Promise<InviteResult>;
  track(event: AnalyticsEvent, payload: AnalyticsPayload): void;
}

export type RunShareOutcome = InviteResult | "noBot";

/** Без рода: делится кто угодно, а «продержался» подходит не всем. */
export function runShareText(input: RunShareInput): string {
  return t(input.record ? "run.share.record" : "run.share.text", { time: formatDuration(input.survivalSec) });
}

/** Открылся выбор чата или игрок закрыл его сам — говорить нечего. */
export function runShareNote(outcome: RunShareOutcome): string | null {
  return outcome === "shared" || outcome === "cancelled" ? null : t(`run.share.${outcome}`);
}

/** Возвращает строку под кнопками или null, если всё видно и так. */
export async function shareRunResult(input: RunShareInput, deps: RunShareDeps = defaultDeps()): Promise<string | null> {
  if (deps.botUrl === "") return runShareNote("noBot");
  deps.track("share_offered", { context: "run_result", method: "link" });
  const startParam = deps.withAccount ? await deps.link() : null;
  const url = startParam === null ? deps.botUrl : friendInviteUrl(deps.botUrl, startParam);
  const result = await deps.invite({ url, text: runShareText(input) });
  deps.track("share_completed", { context: "run_result", method: "link", result });
  return runShareNote(result);
}

function defaultDeps(): RunShareDeps {
  const { adapter, capabilities } = useShell.getState();
  const api = createFriendsApi();
  return {
    botUrl: capabilities.botUrl,
    withAccount: friendsAvailable(),
    link: async () => {
      const link = await api.link();
      return link.ok ? link.data.startParam : null;
    },
    invite: (payload) => adapter.invite(payload),
    track,
  };
}
