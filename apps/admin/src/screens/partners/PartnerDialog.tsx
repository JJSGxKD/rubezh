import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  NO_ACCRUAL_NOTE,
  PARTNER_LIMITS,
  PAYOUT_CURRENCIES,
  TERMS_HELP,
  createPartner,
  emptyPartnerForm,
  partnerFormOf,
  partnerFormSchema,
  updatePartner,
  type Partner,
  type PartnerForm,
} from "../../api/partners";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Button, Field, Input, Select, TextArea } from "../../ui/kit";
import { toast } from "../../ui/toast";

/**
 * Новый партнёр или правка: как его зовёт команда, как связаться, куда и в
 * чём платить и о чём договорились. Статус здесь не меняется — отдельным
 * окном, с причиной. Коды партнёра заводят в «Промокодах» — кнопкой из его
 * карточки, с ним уже выбранным.
 */
export function PartnerDialog({ partner, onClose, onSaved }: { partner: Partner | null; onClose: () => void; onSaved: (partner: Partner) => void }) {
  const form = useForm<PartnerForm>({ resolver: zodResolver(partnerFormSchema), defaultValues: partner === null ? emptyPartnerForm() : partnerFormOf(partner), mode: "onChange" });
  const { errors, isSubmitting, isDirty } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    const result = partner === null ? await createPartner(api, values) : await updatePartner(api, partner.partnerId, values);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(partner === null ? `Партнёр заведён: ${result.data.name}` : `Сохранено: ${result.data.name}`, {
      description: partner === null ? "Теперь заведите ему промокод — кнопкой в карточке" : undefined,
    });
    onSaved(result.data);
    onClose();
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={partner === null ? "Новый партнёр" : `Партнёр «${partner.name}»`}
      description="Блогер, канал или сообщество, которое приводит игроков своими промокодами."
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button tone="primary" type="submit" form="partner-form" disabled={isSubmitting || Object.keys(errors).length > 0 || (partner !== null && !isDirty)}>
            {isSubmitting ? "Сохраняем…" : partner === null ? "Завести" : "Сохранить"}
          </Button>
        </>
      }
    >
      <form id="partner-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <Field label="Название" hint="как его зовёт команда; игроки его не видят" error={errors.name?.message}>
          <Input {...form.register("name")} placeholder="Канал «Игровой угол»" maxLength={PARTNER_LIMITS.nameMax + 10} className="w-full max-w-md" autoFocus />
        </Field>
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Связь</h3>
          <Field label="Как связаться" help={HELP.partners.contact} error={errors.contact?.message}>
            <Input {...form.register("contact")} placeholder="@corner_admin или https://t.me/corner" maxLength={PARTNER_LIMITS.contactMax + 10} className="w-full max-w-md" />
          </Field>
          <Field label="TG id" hint="число; для будущего кабинета" help={TERMS_HELP.telegramId} error={errors.telegramId?.message}>
            <Input {...form.register("telegramId")} inputMode="numeric" placeholder="123456789" maxLength={24} className="w-full max-w-xs" />
          </Field>
        </section>
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Выплаты</h3>
          <div className="flex flex-wrap gap-3">
            <Field label="Страна" hint="две буквы" help={TERMS_HELP.country} error={errors.country?.message}>
              <Input {...form.register("country")} placeholder="KZ" maxLength={3} className="w-20 uppercase" />
            </Field>
            <Field label="Валюта" help={TERMS_HELP.payoutCurrency} error={errors.payoutCurrency?.message}>
              <Select {...form.register("payoutCurrency")}>
                <option value="">не указана</option>
                {PAYOUT_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Процент" hint="от 0 до 100" help={TERMS_HELP.sharePercent} error={errors.sharePercent?.message}>
              <Input {...form.register("sharePercent")} inputMode="decimal" placeholder="12.5" maxLength={7} className="w-28" />
            </Field>
          </div>
          <Field label="Способ выплаты" help={TERMS_HELP.payoutMethod} error={errors.payoutMethod?.message}>
            <Input {...form.register("payoutMethod")} placeholder="USDT TRC-20 на T…" maxLength={PARTNER_LIMITS.payoutMethodMax + 10} className="w-full max-w-md" />
          </Field>
          <p className="max-w-md text-xs text-text-muted">Процент пока только записывается — {NO_ACCRUAL_NOTE}.</p>
        </section>
        <Field label={`Договорённости — ${String(form.watch("note").trim().length)} из ${String(PARTNER_LIMITS.noteMax)}`} help={HELP.partners.note} error={errors.note?.message}>
          <TextArea {...form.register("note")} rows={4} placeholder="Пост раз в неделю до декабря, код на 500 монет новичкам" className="w-full max-w-md" />
        </Field>
      </form>
    </Dialog>
  );
}
