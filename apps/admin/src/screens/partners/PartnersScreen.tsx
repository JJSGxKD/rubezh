import { useEffect, useState } from "react";
import { fetchPartners, share, type Partner } from "../../api/partners";
import { formatNumber } from "../../format";
import { api } from "../../services";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { HELP } from "../../ui/help";
import { Button, DataTable, ErrorNotice, Loading, Notice, Panel } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";
import { PartnerCard } from "./PartnerCard";
import { PartnerDialog } from "./PartnerDialog";

/**
 * Партнёры (docs/35-stage4-plan.md WP41, часть 2): кто приводит игроков
 * своими промокодами и что эти игроки принесли — от кодов до звёзд. Число
 * без доли не говорит ничего, поэтому у сыгравших и платящих рядом — доля
 * от приведённых. Карточка открывается и по адресу `#/partners/<id>`: на
 * неё ведёт карточка игрока.
 */
export function PartnersScreen({ id }: { id: string | null }) {
  const { state, reload } = useApi(() => fetchPartners(api), []);
  const view = useSession((session) => session.view);
  const canEdit = can(view, "partners.edit");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(id);

  useEffect(() => setOpenId(id), [id]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const { partners, rules } = state.data;

  const close = () => {
    setOpenId(null);
    if (id !== null) navigate({ section: "partners", id: null });
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Партнёры"
        help={HELP.partners.section}
        actions={
          canEdit ? (
            <Button tone="primary" onClick={() => setCreating(true)}>
              Новый партнёр
            </Button>
          ) : null
        }
      >
        <div className="mb-3">
          <Notice tone="info">
            Партнёр приводит игроков своими промокодами. Новичок — аккаунт не старше {rules.bindWindowDays} дней, — которого ещё никто не пригласил, записывается за
            партнёром при вводе его кода. Выплат партнёрам пока нет — здесь видно, сколько стоят приведённые ими игроки.
          </Notice>
        </div>
        <DataTable
          rows={partners}
          rowKey={(partner) => partner.partnerId}
          onRowClick={(partner) => setOpenId(partner.partnerId)}
          empty={canEdit ? "Партнёров ещё нет — заведите первого кнопкой «Новый партнёр»" : "Партнёров ещё нет"}
          columns={[
            {
              title: "Партнёр",
              render: (partner) => (
                <span className="flex flex-col">
                  <span className="font-medium">{partner.name}</span>
                  {partner.contact === null ? null : <span className="text-xs text-text-muted">{partner.contact}</span>}
                </span>
              ),
            },
            { title: "Коды", help: HELP.partners.codes, render: (partner) => <CodesCell partner={partner} /> },
            { title: "Активации", help: HELP.partners.redeemed, align: "right", render: (partner) => formatNumber(partner.stats.redeemed) },
            { title: "Привёл", help: HELP.partners.bound, align: "right", render: (partner) => formatNumber(partner.stats.bound) },
            { title: "Играли", help: HELP.partners.played, align: "right", render: (partner) => <Ratio part={partner.stats.played} whole={partner.stats.bound} /> },
            { title: "Платили", help: HELP.partners.payers, align: "right", render: (partner) => <Ratio part={partner.stats.payers} whole={partner.stats.bound} /> },
            { title: "Звёзды", help: HELP.partners.stars, align: "right", render: (partner) => formatNumber(partner.stats.stars) },
          ]}
        />
      </Panel>

      {creating ? (
        <PartnerDialog
          partner={null}
          onClose={() => setCreating(false)}
          onSaved={(partner) => {
            reload();
            setOpenId(partner.partnerId);
          }}
        />
      ) : null}
      {openId === null || creating ? null : <PartnerCard partnerId={openId} canEdit={canEdit} onClose={close} onChanged={reload} />}
    </div>
  );
}

function CodesCell({ partner }: { partner: Partner }) {
  if (partner.stats.codes === 0) return <span className="text-text-muted">нет</span>;
  return (
    <span className="whitespace-nowrap">
      {formatNumber(partner.stats.activeCodes)}
      <span className="text-text-muted"> действуют из {formatNumber(partner.stats.codes)}</span>
    </span>
  );
}

/** Число и доля от приведённых — одной строкой. */
export function Ratio({ part, whole }: { part: number; whole: number }) {
  return (
    <span className="whitespace-nowrap">
      {formatNumber(part)}
      <span className="text-text-muted"> · {share(part, whole)}</span>
    </span>
  );
}
