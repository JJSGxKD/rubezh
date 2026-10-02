import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  AD_PLATFORMS,
  FORMAT_TITLES,
  PLACE_TITLES,
  PLATFORM_TITLES,
  networkFormOf,
  networkFormSchema,
  networkReady,
  placeOptions,
  profileOf,
  saveNetwork,
  type AdNetwork,
  type AdNetworkProfile,
  type AdPlatform,
  type AdsView,
  type NetworkForm,
} from "../../api/ads";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { InlineCode } from "../../ui/inline-code";
import { Badge, Button, Field, Help, Input, Notice, Panel } from "../../ui/kit";
import { toast } from "../../ui/toast";

/**
 * Сети карточками (docs/35-stage4-plan.md WP12, часть 5): у каждой — что она
 * умеет и в каких местах показывает, её ключи по профилю, место в круге и
 * включённость. Включить сеть без обязательных ключей нельзя — галочка
 * подскажет, каких не хватает; ключ не того вида подсвечивается у поля.
 */
export function NetworkCards({ view, canEdit, onSaved }: { view: AdsView; canEdit: boolean; onSaved: () => void }) {
  return (
    <Panel title="Сети" help={HELP.ads.networks}>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {view.networks.map((network) => (
          <NetworkCard key={network.networkKey} view={view} network={network} profile={profileOf(view, network.networkKey)} canEdit={canEdit} onSaved={onSaved} />
        ))}
      </div>
    </Panel>
  );
}

/** Где работает SDK сети — словами для значка карточки. */
function platformsLabel(platforms: readonly AdPlatform[]): string {
  if (platforms.length === AD_PLATFORMS.length) return "все площадки";
  return platforms.length === 1 ? `только ${PLATFORM_TITLES[platforms[0] ?? "telegram"]}` : platforms.map((platform) => PLATFORM_TITLES[platform]).join(", ");
}

function stateBadge(network: AdNetwork) {
  if (network.active && networkReady(network)) return <Badge tone="success">включена</Badge>;
  if (network.active) return <Badge tone="danger">включена, но без ключей — не показывает</Badge>;
  if (!networkReady(network)) return <Badge tone="warning">не настроена</Badge>;
  return <Badge>выключена</Badge>;
}

function NetworkCard({ view, network, profile, canEdit, onSaved }: { view: AdsView; network: AdNetwork; profile: AdNetworkProfile | undefined; canEdit: boolean; onSaved: () => void }) {
  const form = useForm<NetworkForm>({ resolver: zodResolver(networkFormSchema(profile)), defaultValues: networkFormOf(network, profile), mode: "onChange" });
  const { errors, isSubmitting, isDirty } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    const result = await saveNetwork(api, network.networkKey, values);
    if (!result.ok) {
      toast.error(`${network.name}: ${result.error.message}`);
      return;
    }
    toast.success(`${result.data.name}: ${result.data.active ? "включена" : "выключена"}, место в круге ${String(result.data.priority)}`, {
      description: "Выдача увидит правку в течение полуминуты",
    });
    form.reset(networkFormOf(result.data, profile));
    onSaved();
  });

  const places = placeOptions(view, network.networkKey).filter((option) => option.support !== null);

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3 rounded-sm border border-border bg-surface-sunken p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{network.name}</h3>
        {stateBadge(network)}
        {profile === undefined ? null : (
          <span className="inline-flex items-center gap-1">
            <Badge>{platformsLabel(profile.platforms)}</Badge>
            <Help text={HELP.ads.platforms} />
          </span>
        )}
        {profile?.trackAudience === true ? (
          <span className="inline-flex items-center gap-1">
            <Badge tone="info">SDK у всех игроков</Badge>
            <Help text={HELP.ads.audience} />
          </span>
        ) : null}
        {profile === undefined ? null : profile.verified ? (
          <span className="inline-flex items-center gap-1">
            <Badge tone="info">сверено с документацией</Badge>
            <Help text={HELP.ads.verified} />
          </span>
        ) : (
          <Badge tone="warning">сверить с кабинетом</Badge>
        )}
        {profile?.cabinet === null || profile?.cabinet === undefined ? null : (
          <a href={profile.cabinet} target="_blank" rel="noreferrer noopener" className="ml-auto text-xs text-accent hover:underline">
            кабинет сети ↗
          </a>
        )}
      </header>

      {profile === undefined ? (
        <Notice>Сети нет в коде — её SDK не подключён, настроить и включить её нельзя.</Notice>
      ) : (
        <>
          <section className="flex flex-col gap-1.5">
            <p className="flex items-center gap-1.5 text-xs text-text-muted">
              Что показывает и где
              <Help text={HELP.ads.formats} />
            </p>
            <ul className="flex flex-col gap-1.5 text-sm">
              {profile.formats.map((support) => (
                <li key={support.format} className="leading-snug">
                  <span className="font-medium">{FORMAT_TITLES[support.format] ?? support.format}</span>
                  {support.delivery === "api" ? (
                    <span className="ml-1.5 inline-flex items-center gap-1 align-middle">
                      <Badge>наш блок</Badge>
                      <Help text={HELP.ads.delivery} />
                    </span>
                  ) : null}
                  <span className="text-text-muted">
                    {" — "}
                    <InlineCode text={support.title} />
                  </span>
                  <span className="block text-xs text-text-muted">
                    {places
                      .filter((option) => option.support?.format === support.format)
                      .map((option) => PLACE_TITLES[option.place])
                      .join(", ")}
                    {support.maxActive === undefined ? "" : ` · включённых блоков не больше ${String(support.maxActive)}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-xs text-text-muted">
              Ключи сети
              <Help text={HELP.ads.keys} />
            </p>
            {profile.keys.length === 0 ? (
              <p className="text-sm text-text-muted">Ключей у сети нет — всё нужное задаётся в каждом блоке.</p>
            ) : (
              profile.keys.map((field) => (
                <Field key={field.key} label={field.title} hint={field.hint} error={errors.keys?.[field.key]?.message}>
                  <Input
                    {...form.register(`keys.${field.key}`, { onChange: () => void form.trigger("active") })}
                    placeholder={field.example}
                    disabled={!canEdit}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </Field>
              ))
            )}
          </section>

          <div className="flex flex-wrap items-end gap-3">
            <Field label="Место в круге" hint="меньше — раньше" help={HELP.ads.priority} error={errors.priority?.message}>
              <Input type="number" min={0} step={1} {...form.register("priority", { valueAsNumber: true })} disabled={!canEdit} className="w-24" />
            </Field>
            <div className="flex flex-col gap-1 pb-1.5">
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" {...form.register("active", { onChange: () => void form.trigger("keys") })} disabled={!canEdit} />
                включена
              </label>
              {errors.active?.message === undefined ? null : (
                <span role="alert" className="text-xs text-danger">
                  {errors.active.message}
                </span>
              )}
            </div>
            {canEdit ? (
              <Button tone="primary" type="submit" disabled={!isDirty || isSubmitting} className="ml-auto">
                {isSubmitting ? "Сохраняем…" : "Сохранить"}
              </Button>
            ) : null}
          </div>
          {network.missing.length > 0 && !isDirty ? <Notice tone="info">Не хватает: {network.missing.join(", ")} — без них сеть не показывает.</Notice> : null}
          {network.problem === null ? null : <Notice>{network.problem}</Notice>}
        </>
      )}
    </form>
  );
}
