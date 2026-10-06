import { useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import { fetchSocial, REFERRAL_STATUSES, rejectReferral } from "../../api/players";
import { formatDateTime } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { Button, ErrorNotice, Field, Input, KeyValue, Loading, Notice, Panel } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";

/**
 * Друзья и рефералка игрока. Модератор, разбирая накрутку, видит, кем игрок
 * приглашён или каким партнёром приведён и скольких привёл сам, и отклоняет
 * ожидающую привязку — награда пригласившему тогда не начислится
 * (docs/23-referral-and-partner-program.md §2.4). Слот источника один: либо
 * друг, либо партнёр (там же, §5).
 */
export function SocialPanel({ accountId }: { accountId: string }) {
  const { state, reload } = useApi(() => fetchSocial(api, accountId), [accountId]);
  const view = useSession((session) => session.view);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null>(null);

  const reject = async () => {
    setConfirming(false);
    const result = await rejectReferral(api, accountId, reason.trim());
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: result.data.rejected ? "Привязка отклонена — награда пригласившему не начислится" : "Отклонять нечего: привязка уже активирована или отклонена" });
    reload();
  };

  return (
    <Panel title="Друзья и рефералка">
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <div className="flex flex-col gap-3">
          <KeyValue
            items={[
              ["Друзей", String(state.data.friends)],
              [
                "Приглашён",
                state.data.referredBy === null ? (
                  state.data.partner === null ? (
                    "пришёл сам"
                  ) : (
                    <span>
                      партнёром{" "}
                      <button type="button" className="hover:text-accent" onClick={() => navigate({ section: "partners", id: state.data.partner?.partnerId ?? null })}>
                        {state.data.partner.name}
                      </button>
                      {state.data.partner.code === null ? null : (
                        <>
                          {" "}
                          по коду <span className="font-mono">{state.data.partner.code}</span>
                        </>
                      )}
                      , {formatDateTime(state.data.partner.boundAt)}
                    </span>
                  )
                ) : (
                  <span>
                    <button type="button" className="hover:text-accent" onClick={() => navigate({ section: "players", id: state.data.referredBy?.referrerId ?? null })}>
                      {state.data.referredBy.referrerName ?? state.data.referredBy.referrerId}
                    </button>{" "}
                    — {REFERRAL_STATUSES[state.data.referredBy.status] ?? state.data.referredBy.status}, {formatDateTime(state.data.referredBy.boundAt)}
                    {state.data.referredBy.rejectReason === null ? null : ` (${state.data.referredBy.rejectReason})`}
                  </span>
                ),
              ],
              ["Привёл", `${state.data.referrals.activated} активировано, ${state.data.referrals.bound} ждут, ${state.data.referrals.rejected} отклонено`],
            ]}
          />
          {state.data.referredBy?.status === "bound" && can(view, "players.ban") ? (
            <div className="flex items-end gap-2">
              <Field label="Причина отклонения" hint="Попадёт в аудит вместе с прежним статусом.">
                <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={256} className="w-80" />
              </Field>
              {confirming ? (
                <>
                  <Button tone="danger" onClick={() => void reject()}>
                    Да, отклонить
                  </Button>
                  <Button onClick={() => setConfirming(false)}>Отмена</Button>
                </>
              ) : (
                <Button tone="danger" disabled={reason.trim().length < 3} onClick={() => setConfirming(true)}>
                  Отклонить привязку
                </Button>
              )}
            </div>
          ) : null}
          {outcome === null ? null : outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}
        </div>
      ) : null}
    </Panel>
  );
}
