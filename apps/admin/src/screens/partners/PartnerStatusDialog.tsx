import { useState } from "react";
import {
  NO_BINDING_NOTE,
  PARTNER_LIMITS,
  PARTNER_STATUSES,
  STATUS_TITLES,
  TERMS_HELP,
  bindsNewPlayers,
  setPartnerStatus,
  type Partner,
  type PartnerStatus,
} from "../../api/partners";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { Button, Field, Notice, Select, TextArea } from "../../ui/kit";
import { toast } from "../../ui/toast";

/**
 * Смена статуса партнёра: новый статус и причина. Причина обязательна и уходит
 * в журнал аудита вместе с «было → стало». Статус решает только, привязывает ли
 * партнёр новых игроков: приведённых раньше смена не отнимает.
 */
export function PartnerStatusDialog({ partner, onClose, onSaved }: { partner: Partner; onClose: () => void; onSaved: (partner: Partner) => void }) {
  const [status, setStatus] = useState<PartnerStatus>(partner.status);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const trimmed = reason.trim();
  const valid = status !== partner.status && trimmed.length >= PARTNER_LIMITS.reasonMin && trimmed.length <= PARTNER_LIMITS.reasonMax;

  const submit = async () => {
    setSaving(true);
    const result = await setPartnerStatus(api, partner.partnerId, status, trimmed);
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(`Статус партнёра «${result.data.name}»: ${STATUS_TITLES[result.data.status]}`);
    onSaved(result.data);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Статус партнёра «${partner.name}»`}
      description="Смена записывается в журнал аудита вместе с причиной."
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button tone="primary" disabled={!valid || saving} onClick={() => void submit()}>
            {saving ? "Сохраняем…" : "Сменить статус"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Статус" help={TERMS_HELP.status}>
          <Select
            value={status}
            onChange={(event) => {
              const next = PARTNER_STATUSES.find((known) => known === event.target.value);
              if (next !== undefined) setStatus(next);
            }}
          >
            {PARTNER_STATUSES.map((known) => (
              <option key={known} value={known}>
                {STATUS_TITLES[known]}
                {known === partner.status ? " — сейчас" : ""}
              </option>
            ))}
          </Select>
        </Field>
        {bindsNewPlayers(status) ? null : (
          <Notice tone="warning">
            {NO_BINDING_NOTE}. Код партнёра по-прежнему даёт награду, а приведённые раньше остаются за ним.
          </Notice>
        )}
        <Field label={`Причина — ${String(trimmed.length)} из ${String(PARTNER_LIMITS.reasonMax)}`} hint={`от ${String(PARTNER_LIMITS.reasonMin)} знаков; её увидит команда в аудите`}>
          <TextArea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} placeholder="Не выходит на связь с сентября" className="w-full max-w-md" />
        </Field>
      </div>
    </Dialog>
  );
}
