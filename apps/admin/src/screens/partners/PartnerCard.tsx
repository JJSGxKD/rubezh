import { useState, type ReactNode } from "react";
import { PARTNER_CODE_ROUTE, fetchPartner, share, type PartnerDetail } from "../../api/partners";
import { STATE_TITLES, STATE_TONES, batchMask } from "../../api/promo-codes";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { DailyBars } from "../../ui/daily-bars";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Help, KeyValue, Loading } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";
import { PartnerDialog } from "./PartnerDialog";

/**
 * Карточка партнёра: что он принёс — плитками сверху, привязки по дням,
 * его коды с тем, сколько игроков привязал каждый. «Завести код партнёра»
 * открывает мастер промокодов с ним уже выбранным.
 */
export function PartnerCard({ partnerId, canEdit, onClose, onChanged }: { partnerId: string; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const { state, reload } = useApi(() => fetchPartner(api, partnerId), [partnerId]);
  const [editing, setEditing] = useState(false);
  const detail = state.status === "ok" ? state.data : null;

  if (editing && detail !== null) {
    return (
      <PartnerDialog
        partner={detail.partner}
        onClose={() => setEditing(false)}
        onSaved={() => {
          reload();
          onChanged();
        }}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={detail?.partner.name ?? "Партнёр"}
      description={detail === null ? undefined : (detail.partner.contact ?? "Связь не указана")}
      footer={
        detail === null ? undefined : (
          <>
            {canEdit ? (
              <Button className="mr-auto" onClick={() => setEditing(true)}>
                Изменить
              </Button>
            ) : null}
            <Button tone="primary" onClick={() => navigate({ section: "promo-codes", id: `${PARTNER_CODE_ROUTE}${detail.partner.partnerId}` })}>
              Завести код партнёра
            </Button>
          </>
        )
      }
    >
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {detail === null ? null : <CardBody detail={detail} />}
    </Dialog>
  );
}

function CardBody({ detail }: { detail: PartnerDetail }) {
  const { stats } = detail.partner;
  return (
    <div className="flex flex-col gap-5">
      <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile title="Привёл" help={HELP.partners.bound} value={formatNumber(stats.bound)} sub={`из ${formatNumber(stats.redeemed)} активаций его кодов`} />
        <Tile title="Играли" help={HELP.partners.played} value={formatNumber(stats.played)} sub={`${share(stats.played, stats.bound)} приведённых`} />
        <Tile title="Платили" help={HELP.partners.payers} value={formatNumber(stats.payers)} sub={`${share(stats.payers, stats.bound)} приведённых`} />
        <Tile title="Звёзды" help={HELP.partners.stars} value={formatNumber(stats.stars)} sub={stats.payers === 0 ? "оплат ещё нет" : `${formatNumber(Math.round(stats.stars / stats.payers))} на платящего`} />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          Привязки по дням
          <Help text={HELP.partners.daily} />
        </h3>
        <DailyBars daily={detail.daily} what="привязок" />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          Коды партнёра
          <Help text={HELP.partners.codes} />
        </h3>
        <DataTable
          rows={detail.codes}
          rowKey={(code) => code.campaignId}
          onRowClick={(code) => navigate({ section: "promo-codes", id: code.campaignId })}
          empty="Кодов ещё нет — заведите кнопкой внизу"
          columns={[
            {
              title: "Код",
              render: (code) => <span className="font-mono">{code.kind === "batch" ? batchMask(code.codeSample) : code.codeSample}</span>,
            },
            { title: "Название", render: (code) => code.title },
            { title: "Активации", align: "right", render: (code) => `${formatNumber(code.redeemed)}${code.maxRedemptions === null ? "" : ` из ${formatNumber(code.maxRedemptions)}`}` },
            { title: "Привязал", align: "right", render: (code) => formatNumber(code.bound) },
            { title: "Срок", render: (code) => (code.endsAt === null ? "бессрочно" : `до ${formatDateTime(code.endsAt)}`) },
            { title: "Состояние", render: (code) => <Badge tone={STATE_TONES[code.state] ?? "neutral"}>{STATE_TITLES[code.state] ?? code.state}</Badge> },
          ]}
        />
      </section>

      <KeyValue
        items={[
          ["Договорённости", detail.partner.note ?? <span className="text-text-muted">—</span>, HELP.partners.note],
          ["Заведён", formatDateTime(detail.partner.createdAt)],
          ["Окно привязки", `новички до ${String(detail.rules.bindWindowDays)} дней с регистрации`, HELP.partners.window],
        ]}
      />
    </div>
  );
}

function Tile({ title, help, value, sub }: { title: string; help: string; value: string; sub: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-sm border border-border bg-surface-sunken px-3 py-2.5">
      <span className="flex items-center gap-1 text-xs text-text-muted">
        {title}
        <Help text={help} />
      </span>
      <span className="font-display text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-text-muted">{sub}</span>
    </div>
  );
}
