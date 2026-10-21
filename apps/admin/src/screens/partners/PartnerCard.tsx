import { useState, type ReactNode } from "react";
import { LINK_PARTNER_ROUTE, NETWORK_TITLES, TARGET_TITLES, launchesLabel } from "../../api/links";
import {
  LINKS_BOUND_HELP,
  LINKS_HELP,
  NO_ACCRUAL_NOTE,
  NO_BINDING_NOTE,
  NO_LINK_FOR_INACTIVE,
  PARTNER_CODE_ROUTE,
  STATUS_TITLES,
  TERMS_HELP,
  bindsNewPlayers,
  fetchPartner,
  share,
  statusTone,
  type PartnerDetail,
} from "../../api/partners";
import { STATE_TITLES, STATE_TONES, batchMask } from "../../api/promo-codes";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { DailyBars } from "../../ui/daily-bars";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Help, KeyValue, Loading } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";
import { PartnerDialog } from "./PartnerDialog";
import { PartnerStatusDialog } from "./PartnerStatusDialog";

/**
 * Карточка партнёра: статус и условия выплат, что он принёс — плитками,
 * привязки по дням, его коды с тем, сколько игроков привязал каждый, и его
 * ссылки с кликами, запусками и привязанными (T-0067). «Сменить статус…» —
 * отдельное окно с причиной. «Завести код партнёра» и «Завести ссылку»
 * открывают мастер промокодов и мастер ссылок с ним уже выбранным.
 */
export function PartnerCard({ partnerId, canEdit, onClose, onChanged }: { partnerId: string; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const { state, reload } = useApi(() => fetchPartner(api, partnerId), [partnerId]);
  const view = useSession((session) => session.view);
  const canLink = can(view, "links.manage");
  const [editing, setEditing] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
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

  if (changingStatus && detail !== null) {
    return (
      <PartnerStatusDialog
        partner={detail.partner}
        onClose={() => setChangingStatus(false)}
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
            {canLink ? (
              <Button
                disabled={!bindsNewPlayers(detail.partner.status)}
                title={bindsNewPlayers(detail.partner.status) ? undefined : NO_LINK_FOR_INACTIVE}
                onClick={() => navigate({ section: "links", id: `${LINK_PARTNER_ROUTE}${detail.partner.partnerId}` })}
              >
                Завести ссылку
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
      {detail === null ? null : <CardBody detail={detail} canEdit={canEdit} canLink={canLink} onChangeStatus={() => setChangingStatus(true)} />}
    </Dialog>
  );
}

function CardBody({ detail, canEdit, canLink, onChangeStatus }: { detail: PartnerDetail; canEdit: boolean; canLink: boolean; onChangeStatus: () => void }) {
  const { stats, status } = detail.partner;
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs text-text-muted">
          Статус
          <Help text={TERMS_HELP.status} />
        </span>
        <Badge tone={statusTone(status)}>{STATUS_TITLES[status]}</Badge>
        {canEdit ? <Button onClick={onChangeStatus}>Сменить статус…</Button> : null}
        {bindsNewPlayers(status) ? null : <span className="text-xs text-warning">{NO_BINDING_NOTE}</span>}
      </section>

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

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          Ссылки партнёра
          <Help text={LINKS_HELP} />
        </h3>
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          Привязано по ссылкам: {formatNumber(detail.linkBound)} из {formatNumber(stats.bound)} приведённых
          <Help text={LINKS_BOUND_HELP} />
        </p>
        <DataTable
          rows={detail.links}
          rowKey={(link) => link.code}
          onRowClick={(link) => navigate({ section: "links", id: link.code })}
          empty={canLink ? "Ссылок ещё нет — заведите кнопкой внизу" : "Ссылок ещё нет"}
          columns={[
            {
              title: "Кампания",
              render: (link) => (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {link.campaign}
                  {link.network === null ? null : <Badge tone="accent">{NETWORK_TITLES[link.network]}</Badge>}
                  {link.target === "app" ? null : <Badge>{TARGET_TITLES[link.target]}</Badge>}
                </span>
              ),
            },
            { title: "Код", render: (link) => <code className="text-xs">{link.code}</code> },
            { title: "Кликов", align: "right", render: (link) => formatNumber(link.clicks) },
            { title: "За 30 дней", align: "right", render: (link) => formatNumber(link.clicks30d) },
            { title: "Запусков", help: HELP.links.launches, align: "right", render: (link) => <span className="whitespace-nowrap">{launchesLabel(link)}</span> },
            { title: "Привязала", align: "right", render: (link) => formatNumber(link.bound) },
            { title: "Заведена", render: (link) => formatDateTime(link.createdAt) },
          ]}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Выплаты</h3>
        <KeyValue
          items={[
            ["Страна", detail.partner.country ?? dash, TERMS_HELP.country],
            ["Валюта", detail.partner.payoutCurrency ?? dash, TERMS_HELP.payoutCurrency],
            ["Способ", detail.partner.payoutMethod ?? dash],
            [
              "Процент",
              detail.partner.sharePercent === null ? (
                dash
              ) : (
                <span>
                  {detail.partner.sharePercent}% <span className="text-text-muted">· {NO_ACCRUAL_NOTE}</span>
                </span>
              ),
              TERMS_HELP.sharePercent,
            ],
          ]}
        />
      </section>

      <KeyValue
        items={[
          ["TG id", detail.partner.telegramId ?? dash, TERMS_HELP.telegramId],
          ["Договорённости", detail.partner.note ?? dash, HELP.partners.note],
          ["Заведён", formatDateTime(detail.partner.createdAt)],
          ["Окно привязки", `новички до ${String(detail.rules.bindWindowDays)} дней с регистрации`, HELP.partners.window],
        ]}
      />
    </div>
  );
}

const dash = <span className="text-text-muted">—</span>;

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
