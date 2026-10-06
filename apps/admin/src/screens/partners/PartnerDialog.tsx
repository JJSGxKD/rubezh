import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { PARTNER_LIMITS, createPartner, emptyPartnerForm, partnerFormOf, partnerFormSchema, updatePartner, type Partner, type PartnerForm } from "../../api/partners";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Button, Field, Input, TextArea } from "../../ui/kit";
import { toast } from "../../ui/toast";

/**
 * Новый партнёр или правка: как его зовёт команда, как связаться и о чём
 * договорились. Коды партнёра заводят в «Промокодах» — кнопкой из его
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
        <Field label="Как связаться" help={HELP.partners.contact} error={errors.contact?.message}>
          <Input {...form.register("contact")} placeholder="@corner_admin или https://t.me/corner" maxLength={PARTNER_LIMITS.contactMax + 10} className="w-full max-w-md" />
        </Field>
        <Field label={`Договорённости — ${String(form.watch("note").trim().length)} из ${String(PARTNER_LIMITS.noteMax)}`} help={HELP.partners.note} error={errors.note?.message}>
          <TextArea {...form.register("note")} rows={4} placeholder="Пост раз в неделю до декабря, код на 500 монет новичкам" className="w-full max-w-md" />
        </Field>
      </form>
    </Dialog>
  );
}
