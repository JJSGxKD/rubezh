import type { ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import {
  AD_DEVICES,
  AD_PLATFORMS,
  DEVICE_TITLES,
  FORMAT_TITLES,
  PLACE_TITLES,
  PLATFORM_TITLES,
  SUCCESS_HINTS,
  SUCCESS_TITLES,
  blockFormSchema,
  blockInputOf,
  networkReady,
  placeOptions,
  profileOf,
  saveBlock,
  supportFor,
  type AdBlock,
  type AdPlace,
  type AdsView,
  type BlockForm,
} from "../../api/ads";
import { api } from "../../services";
import { ChoiceCards } from "../../ui/choice";
import { Dialog } from "../../ui/dialog";
import { InlineCode } from "../../ui/inline-code";
import { HELP } from "../../ui/help";
import { Badge, Button, Field, Help, Input, Notice } from "../../ui/kit";
import { toast } from "../../ui/toast";

/**
 * Блок места — по шагам (docs/35-stage4-plan.md WP12, часть 5): сеть → место
 * → блок в кабинете → где показывать. Каждый шаг сужает следующий по профилю
 * сети: место — только формата сети, недоступные видны с причиной; поле блока
 * — с видом и примером формата, а у формата без блока поля нет вовсе;
 * условие успеха задаёт формат. Задание AdsGram на крутку колеса так не
 * собрать — колесу нужно видео за награду.
 *
 * У заведённого блока сеть и место не меняются: по ним посчитана воронка.
 */
export function BlockDialog({ view, block, onClose, onSaved }: { view: AdsView; block: AdBlock | "new"; onClose: () => void; onSaved: () => void }) {
  const editing = block === "new" ? null : block;
  const defaults: BlockForm =
    editing === null
      ? { networkKey: "", place: "", externalId: "", success: "", active: true, platforms: [], devices: [] }
      : { networkKey: editing.networkKey, place: editing.place, externalId: editing.externalId ?? "", success: editing.success, active: editing.active, platforms: [...editing.platforms], devices: [...editing.devices] };
  const form = useForm<BlockForm>({ resolver: zodResolver(blockFormSchema(view, editing?.blockId ?? null)), defaultValues: defaults, mode: "onChange" });
  const { errors, isSubmitting } = form.formState;
  const networkKey = form.watch("networkKey");
  const place = form.watch("place");
  const profile = profileOf(view, networkKey);
  const support = place === "" ? undefined : supportFor(view, networkKey, place);
  const network = view.networks.find((candidate) => candidate.networkKey === networkKey);
  const input = blockInputOf(view, form.watch(), editing?.blockId ?? null);

  const chooseNetwork = (next: string): void => {
    form.setValue("networkKey", next, { shouldValidate: true, shouldDirty: true });
    // Другая сеть — другие форматы: место и блок выбираются заново.
    form.setValue("place", "", { shouldDirty: true });
    form.setValue("externalId", "", { shouldDirty: true });
    form.setValue("success", "", { shouldDirty: true });
  };
  const choosePlace = (next: AdPlace): void => {
    form.setValue("place", next, { shouldValidate: true, shouldDirty: true });
    const nextSupport = supportFor(view, networkKey, next);
    form.setValue("externalId", nextSupport?.unit?.options?.[0]?.value ?? "", { shouldValidate: true, shouldDirty: true });
    form.setValue("success", nextSupport?.success[0] ?? "", { shouldValidate: true, shouldDirty: true });
  };

  const submit = form.handleSubmit(async (values) => {
    const ready = blockInputOf(view, values, editing?.blockId ?? null);
    if (ready === null) return;
    const result = await saveBlock(api, ready);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(`${editing === null ? "Блок заведён" : "Блок сохранён"}: ${profile?.title ?? networkKey}, ${PLACE_TITLES[result.data.place]}`, {
      description: "Выдача увидит его в течение полуминуты",
    });
    onSaved();
    onClose();
  });

  const networks = view.networks.filter((candidate) => profileOf(view, candidate.networkKey) !== undefined);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={editing === null ? "Новый блок места" : "Блок места"}
      description={editing === null ? "Сеть → место → блок из кабинета → где показывать. Каждый шаг подстраивается под сеть." : "Сеть и место не меняются: по ним посчитана воронка. Нужен другой — заведите новый блок и выключите этот."}
      footer={
        <>
          {input === null ? null : (
            <span className="mr-auto text-xs text-text-muted">
              {profile?.title} · {PLACE_TITLES[input.place]} · {FORMAT_TITLES[support?.format ?? ""] ?? support?.format}
              {input.externalId === null ? " · без блока" : ` · ${input.externalId}`} · успех — {SUCCESS_TITLES[input.success]}
            </span>
          )}
          <Button onClick={onClose}>Отмена</Button>
          <Button tone="primary" type="submit" form="ad-block-form" disabled={isSubmitting || input === null || Object.keys(errors).length > 0}>
            {isSubmitting ? "Сохраняем…" : editing === null ? "Завести" : "Сохранить"}
          </Button>
        </>
      }
    >
      <form id="ad-block-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
        <Step no={1} title="Сеть">
          <ChoiceCards
            label="Сеть"
            value={networkKey}
            disabled={editing !== null}
            onChange={chooseNetwork}
            choices={networks.map((candidate) => ({
              value: candidate.networkKey,
              title: candidate.name,
              aside: candidate.active && networkReady(candidate) ? <Badge tone="success">включена</Badge> : !networkReady(candidate) ? <Badge tone="warning">нет ключей</Badge> : <Badge>выключена</Badge>,
              description: profileOf(view, candidate.networkKey)
                ?.formats.map((item) => FORMAT_TITLES[item.format] ?? item.format)
                .join(" · "),
            }))}
          />
          {errors.networkKey?.message === undefined ? null : <FieldError message={errors.networkKey.message} />}
          {network !== undefined && (!network.active || !networkReady(network)) ? (
            <Notice tone="info">
              {network.name} {!networkReady(network) ? `без ключей (${network.missing.join(", ")})` : "выключена"} — блок сохранится, но показывать начнёт, когда сеть включат с ключами.
            </Notice>
          ) : null}
        </Step>

        {profile === undefined ? null : (
          <Step no={2} title="Место" help={HELP.ads.place}>
            <ChoiceCards
              label="Место"
              value={place}
              disabled={editing !== null}
              onChange={choosePlace}
              columns={3}
              choices={placeOptions(view, networkKey).map((option) => ({
                value: option.place,
                title: PLACE_TITLES[option.place],
                disabled: option.support === null,
                description: option.support === null ? option.reason : (FORMAT_TITLES[option.support.format] ?? option.support.format),
              }))}
            />
            {errors.place?.message === undefined ? null : <FieldError message={errors.place.message} />}
          </Step>
        )}

        {support === undefined ? null : (
          <Step no={3} title={support.unit === null ? "Блок в кабинете — не нужен" : support.unit.title} help={HELP.ads.externalId}>
            <p className="text-xs text-text-muted">
              <InlineCode text={support.title} />
            </p>
            {support.unit === null ? (
              <Notice tone="info">
                <InlineCode text={support.note ?? "У формата нет блока в кабинете — показ идёт по ключам сети."} />
              </Notice>
            ) : support.unit.options !== undefined ? (
              <>
                <Controller
                  control={form.control}
                  name="externalId"
                  render={({ field }) => (
                    <ChoiceCards
                      label={support.unit?.title ?? ""}
                      value={field.value}
                      onChange={(value) => field.onChange(value)}
                      choices={support.unit?.options?.map((option) => ({ value: option.value, title: <InlineCode text={option.title} />, description: <InlineCode text={option.hint} /> })) ?? []}
                    />
                  )}
                />
                <p className="text-xs text-text-muted">{support.unit.hint}</p>
              </>
            ) : (
              <Field label={support.unit.title} hint={support.unit.hint} error={errors.externalId?.message}>
                <Input {...form.register("externalId")} placeholder={support.unit.example} autoComplete="off" spellCheck={false} className="w-72 font-mono" />
              </Field>
            )}
            {support.unit?.options !== undefined && errors.externalId?.message !== undefined ? <FieldError message={errors.externalId.message} /> : null}
            {support.unit !== null && support.note !== undefined ? (
              <p className="text-xs text-text-muted">
                <InlineCode text={support.note} />
              </p>
            ) : null}
            <p className="flex items-center gap-1.5 text-sm">
              Успех — <span className="font-medium">{support.success.map((success) => SUCCESS_TITLES[success]).join(" или ")}</span>
              <span className="text-xs text-text-muted">({support.success.map((success) => SUCCESS_HINTS[success]).join("; ")})</span>
              <Help text={HELP.ads.success} />
            </p>
            {errors.success?.message === undefined ? null : <FieldError message={errors.success.message} />}
          </Step>
        )}

        {support === undefined ? null : (
          <Step no={4} title="Где показывать" help={HELP.ads.reach}>
            <div className="flex flex-wrap gap-8 text-sm">
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-xs text-text-muted">Площадки — ни одной: все</legend>
                {AD_PLATFORMS.map((platform) => (
                  <label key={platform} className="flex items-center gap-1.5">
                    <input type="checkbox" value={platform} {...form.register("platforms")} />
                    {PLATFORM_TITLES[platform]}
                  </label>
                ))}
              </fieldset>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-xs text-text-muted">Устройства — ни одного: все</legend>
                {AD_DEVICES.map((device) => (
                  <label key={device} className="flex items-center gap-1.5">
                    <input type="checkbox" value={device} {...form.register("devices")} />
                    {DEVICE_TITLES[device]}
                  </label>
                ))}
              </fieldset>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 flex items-center gap-1.5 text-xs text-text-muted">
                  Выдача
                  <Help text={HELP.ads.blockActive} />
                </legend>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" {...form.register("active")} />
                  блок включён
                </label>
                {errors.active?.message === undefined ? null : <FieldError message={errors.active.message} />}
              </fieldset>
            </div>
          </Step>
        )}
      </form>
    </Dialog>
  );
}

function Step({ no, title, help, children }: { no: number; title: string; help?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-accent/15 text-xs text-accent">{no}</span>
        {title}
        {help === undefined ? null : <Help text={help} />}
      </h3>
      {children}
    </section>
  );
}

function FieldError({ message }: { message: string }) {
  return (
    <span role="alert" className="text-xs text-danger">
      {message}
    </span>
  );
}
