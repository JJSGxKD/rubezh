import { useState } from "react";
import { Copy } from "lucide-react";
import { CABINET_ROW_ACTIONS, CABINET_TEXTS, copyBlockedReason, copyRowHint, fetchCabinetPromos, redeemedText, type CabinetPromo } from "../../api/cabinet";
import { STATE_TITLES, STATE_TONES, rewardText } from "../../api/promo-codes";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Help, Loading } from "../../ui/kit";
import { useNarrow } from "../../ui/use-media";
import { useApi } from "../../ui/use-api";
import { CopyPromoDialog } from "./CopyPromoDialog";

/** Код в таблице: общий — словом, у пачки отдельные коды партнёру не показываются. */
function codeCell(promo: CabinetPromo) {
  return promo.kind === "batch" ? <span className="text-text-muted">пачка одноразовых кодов</span> : <span className="font-mono break-words">{promo.code}</span>;
}

/**
 * Вкладка «Промокоды»: кампании партнёра — код, награда словами, погашено из лимита, срок. Новый код — только
 * «Сделать копию с новым словом»: награду и лимит назначает команда. В режиме «глазами партнёра» кнопок нет.
 */
export function PromosTab({ partnerId }: { partnerId: string | null }) {
  const { state, reload } = useApi(() => fetchCabinetPromos(api, partnerId), [partnerId]);
  const [copying, setCopying] = useState<CabinetPromo | null>(null);
  // На телефоне кнопка стоит рядом с текстом карточки: короткая подпись, полная — для чтеца с экрана.
  const narrow = useNarrow();

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const { promos, copies, viewOnly } = state.data;

  return (
    <section className="flex flex-col gap-3">
      <p className="flex items-center gap-1.5 text-sm text-text-muted">
        Копий сделано: {formatNumber(copies.used)} из {formatNumber(copies.max)}
        <Help text={HELP.cabinet.promos} />
      </p>
      {viewOnly || copies.used < copies.max ? null : <p className="text-xs text-text-muted">{CABINET_TEXTS.ceiling}</p>}
      <DataTable
        rows={promos}
        rowKey={(promo) => promo.campaignId}
        empty={viewOnly ? "У партнёра пока нет промокодов" : CABINET_TEXTS.noPromos}
        columns={[
          { title: "Код", primary: true, render: codeCell },
          { title: "Награда", render: (promo) => rewardText(promo.reward) },
          { title: "Погашено", help: HELP.cabinet.redeemed, align: "right", render: (promo) => <span className="whitespace-nowrap">{redeemedText(promo)}</span> },
          { title: "Срок", render: (promo) => (promo.endsAt === null ? "бессрочно" : `до ${formatDateTime(promo.endsAt)}`) },
          {
            title: "Состояние",
            render: (promo) => (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Badge tone={STATE_TONES[promo.state] ?? "neutral"}>{STATE_TITLES[promo.state] ?? promo.state}</Badge>
                {promo.copy ? <Badge tone="info">ваша копия</Badge> : null}
              </span>
            ),
          },
          {
            title: "",
            render: (promo) => {
              if (viewOnly) return null;
              const blocked = copyBlockedReason(promo, copies);
              const hint = copyRowHint(promo, copies);
              return (
                <span className="inline-flex max-w-40 flex-col items-start gap-0.5">
                  <Button disabled={blocked !== null} aria-label={CABINET_ROW_ACTIONS.copyPromoFull} onClick={() => setCopying(promo)}>
                    {narrow ? (
                      <>
                        <Copy size={14} aria-hidden="true" />
                        {CABINET_ROW_ACTIONS.copyPromo}
                      </>
                    ) : (
                      CABINET_ROW_ACTIONS.copyPromoFull
                    )}
                  </Button>
                  {hint === null ? null : <span className="text-xs text-text-muted">{hint}</span>}
                </span>
              );
            },
          },
        ]}
      />
      {copying === null ? null : <CopyPromoDialog source={copying} onClose={() => setCopying(null)} onCopied={reload} />}
    </section>
  );
}
