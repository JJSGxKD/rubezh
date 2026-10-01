import { useState } from "react";
import {
  STATE_TITLES,
  STATE_TONES,
  audienceText,
  codesCsv,
  fetchPromoCode,
  removePromoCode,
  rewardText,
  setPaused,
  type PromoCampaign,
  type PromoCampaignDetail,
} from "../../api/promo-codes";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, ErrorNotice, Help, KeyValue, Loading } from "../../ui/kit";
import { saveFile } from "../../ui/save-file";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { PeriodCell, Usage } from "./PromoCodesScreen";

/**
 * Карточка промокода: сам код с копированием, что он даёт, сколько раз и
 * когда активирован, коды пачки с выгрузкой. Действия — внизу, опасное —
 * вторым нажатием: удалить можно только код, который никто не активировал.
 */
export function PromoCodeCard({ campaignId, onClose, onChanged, onEdit }: { campaignId: string; onClose: () => void; onChanged: () => void; onEdit: (campaign: PromoCampaign) => void }) {
  const { state, reload } = useApi(() => fetchPromoCode(api, campaignId), [campaignId]);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const detail = state.status === "ok" ? state.data : null;
  const campaign = detail?.campaign ?? null;

  const pause = async (paused: boolean) => {
    if (campaign === null) return;
    setBusy(true);
    const result = await setPaused(api, campaign.campaignId, paused);
    setBusy(false);
    if (!result.ok) return void toast.error(result.error.message);
    toast.success(paused ? `${campaign.title}: на паузе — игроки увидят «код сейчас не действует»` : `${campaign.title}: снова действует`);
    reload();
    onChanged();
  };

  const remove = async () => {
    if (campaign === null) return;
    setBusy(true);
    const result = await removePromoCode(api, campaign.campaignId);
    setBusy(false);
    if (!result.ok) return void toast.error(result.error.message);
    toast.success(`${campaign.title}: удалён — код ${campaign.kind === "shared" ? campaign.codeSample : "пачки"} свободен`);
    onChanged();
    onClose();
  };

  const finished = campaign !== null && (campaign.state === "expired" || campaign.state === "exhausted");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={campaign?.title ?? "Промокод"}
      description={campaign === null ? undefined : campaign.kind === "shared" ? "Общий код — один на всех" : `Пачка одноразовых кодов — ${formatNumber(campaign.maxRedemptions ?? 0)} шт.`}
      footer={
        campaign === null ? undefined : (
          <>
            {campaign.redeemed === 0 ? (
              confirmRemove ? (
                <span className="mr-auto flex items-center gap-2">
                  <span className="text-xs text-danger">Удалить без возврата?</span>
                  <Button tone="danger" disabled={busy} onClick={() => void remove()}>
                    Да, удалить
                  </Button>
                  <Button onClick={() => setConfirmRemove(false)}>Нет</Button>
                </span>
              ) : (
                <Button tone="danger" className="mr-auto" onClick={() => setConfirmRemove(true)}>
                  Удалить
                </Button>
              )
            ) : (
              <span className="mr-auto text-xs text-text-muted">Активированный код не удаляется — его ставят на паузу</span>
            )}
            {finished ? null : campaign.pausedAt === null ? (
              <Button disabled={busy} onClick={() => void pause(true)}>
                Поставить на паузу
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void pause(false)}>
                Снять с паузы
              </Button>
            )}
            <Button tone="primary" onClick={() => onEdit(campaign)}>
              Изменить
            </Button>
          </>
        )
      }
    >
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {detail === null || campaign === null ? null : <CardBody detail={detail} campaign={campaign} />}
    </Dialog>
  );
}

function CardBody({ detail, campaign }: { detail: PromoCampaignDetail; campaign: PromoCampaign }) {
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast.success(`${what} скопирован${what.endsWith("ы") ? "ы" : ""}`),
      () => toast.error("Браузер не дал скопировать — выделите вручную"),
    );
  const free = detail.codes.filter((code) => code.redeemedAt === null);

  return (
    <div className="flex flex-col gap-5">
      {campaign.kind === "shared" ? (
        <section className="flex items-center gap-3 rounded-sm border border-border bg-surface-sunken px-4 py-3">
          <span className="font-mono text-2xl font-semibold tracking-wider">{campaign.codeSample}</span>
          <Button onClick={() => copy(campaign.codeSample, "Код")}>Скопировать</Button>
          <span className="ml-auto">
            <Badge tone={STATE_TONES[campaign.state] ?? "neutral"}>{STATE_TITLES[campaign.state] ?? campaign.state}</Badge>
          </span>
        </section>
      ) : (
        <section className="flex flex-wrap items-center gap-3 rounded-sm border border-border bg-surface-sunken px-4 py-3">
          <span className="text-sm">
            Свободно <span className="font-semibold">{formatNumber(free.length)}</span> из {formatNumber(detail.codes.length)}
          </span>
          <Button disabled={free.length === 0} onClick={() => copy(free.map((code) => code.display).join("\n"), "Свободные коды")}>
            Скопировать свободные
          </Button>
          <Button onClick={() => saveFile(new Blob([`﻿${codesCsv(detail.codes)}`], { type: "text/csv;charset=utf-8" }), `promo-${campaign.codeSample.slice(0, 12)}.csv`)}>Скачать CSV</Button>
          <span className="ml-auto">
            <Badge tone={STATE_TONES[campaign.state] ?? "neutral"}>{STATE_TITLES[campaign.state] ?? campaign.state}</Badge>
          </span>
        </section>
      )}

      <KeyValue
        items={[
          ["Награда", rewardText(campaign.reward), HELP.promoCodes.reward],
          ["Активации", <Usage key="usage" campaign={campaign} />, HELP.promoCodes.redeemed],
          ["Срок", <PeriodCell key="period" campaign={campaign} />, HELP.promoCodes.period],
          ["Кому", audienceText(campaign), HELP.promoCodes.audience],
          ["Текст игроку", campaign.message ?? <span className="text-text-muted">общий текст игры</span>, HELP.promoCodes.message],
          ["Заметка", campaign.note ?? <span className="text-text-muted">—</span>, HELP.promoCodes.note],
          ["Заведён", formatDateTime(campaign.createdAt)],
          ...(campaign.pausedAt === null ? [] : [["На паузе с", formatDateTime(campaign.pausedAt)] as [string, string]]),
        ]}
      />

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          Активации по дням
          <Help text={HELP.promoCodes.daily} />
        </h3>
        <DailyBars daily={detail.daily} />
      </section>

      {campaign.kind === "batch" ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Коды пачки</h3>
          <div className="max-h-64 overflow-y-auto rounded-sm border border-border">
            <table className="w-full text-sm">
              <tbody>
                {detail.codes.map((code) => (
                  <tr key={code.display} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-1 font-mono">{code.display}</td>
                    <td className="px-3 py-1 text-right text-xs text-text-muted">{code.redeemedAt === null ? "свободен" : `активирован ${formatDateTime(code.redeemedAt)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

const DAY_MS = 86_400_000;
const DAYS = 30;

/** Столбики за 30 дней: пустые дни — тоже, иначе всплеск после поста не отличить от ровного потока. */
function DailyBars({ daily }: { daily: PromoCampaignDetail["daily"] }) {
  const counts = new Map(daily.map((row) => [row.day, row.count]));
  const today = Date.now();
  const days = Array.from({ length: DAYS }, (_, index) => {
    // Сутки — московские, как на сервере: сдвиг на три часа от UTC.
    const day = new Date(today - (DAYS - 1 - index) * DAY_MS + 3 * 3_600_000).toISOString().slice(0, 10);
    return { day, count: counts.get(day) ?? 0 };
  });
  const max = Math.max(1, ...days.map((row) => row.count));
  const total = days.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) return <p className="text-sm text-text-muted">За 30 дней активаций не было</p>;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-20 items-end gap-0.5" role="img" aria-label={`Активаций за 30 дней: ${String(total)}`}>
        {days.map((row) => (
          <span
            key={row.day}
            title={`${row.day.split("-").reverse().join(".")}: ${String(row.count)}`}
            className={`flex-1 rounded-t-sm ${row.count === 0 ? "bg-surface-raised" : "bg-accent"}`}
            style={{ height: `${String(Math.max(4, Math.round((row.count / max) * 100)))}%` }}
          />
        ))}
      </div>
      <p className="flex justify-between text-xs text-text-muted">
        <span>30 дней назад</span>
        <span>всего {formatNumber(total)}, максимум за день {formatNumber(max)}</span>
        <span>сегодня</span>
      </p>
    </div>
  );
}
