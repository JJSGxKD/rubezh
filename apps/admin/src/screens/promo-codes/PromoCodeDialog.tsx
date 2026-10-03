import { useEffect, useState, type ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import {
  PLATFORM_TITLES,
  REWARD_RESOURCES,
  REWARD_TITLES,
  checkCode,
  createBodyOf,
  createPromoCode,
  emptyForm,
  formOf,
  formSchema,
  layoutHint,
  periodOf,
  randomCode,
  rewardText,
  updateBodyOf,
  updatePromoCode,
  type CodeCheck,
  type PromoCampaign,
  type PromoCodeForm,
  type PromoCodeLimits,
} from "../../api/promo-codes";
import { formatDateTime, formatNumber, localInput } from "../../format";
import { api } from "../../services";
import { ChoiceCards } from "../../ui/choice";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Button, Field, Help, Input, Notice, Select, TextArea } from "../../ui/kit";
import { toast } from "../../ui/toast";

const DAY_MS = 86_400_000;
/** быстрые сроки от начала: чаще всего код живёт сутки, неделю или месяц */
const QUICK_ENDS = [
  { days: 1, title: "сутки" },
  { days: 3, title: "3 дня" },
  { days: 7, title: "неделя" },
  { days: 30, title: "месяц" },
] as const;

/**
 * Мастер промокода (docs/35-stage4-plan.md WP41): какой код → награда →
 * срок и лимит → кому → название и тексты. Каждый шаг объясняет себя, ошибка
 * — у своего поля, а внизу — итог одной строкой: что именно заведётся.
 *
 * Код проверяется на сервере, пока его набирают: занят ли и как его найдёт
 * игрок. У заведённого кода не меняются вид и сам код (его уже напечатали),
 * награда — после первой активации, начало — после начала.
 */
export function PromoCodeDialog({
  limits,
  platforms,
  partners,
  bindWindowDays,
  editing,
  partnerId = "",
  onClose,
  onSaved,
}: {
  limits: PromoCodeLimits;
  platforms: readonly string[];
  partners: readonly { partnerId: string; name: string }[];
  /** окно привязки новичка к партнёру, суток */
  bindWindowDays: number;
  editing: PromoCampaign | null;
  /** партнёр, выбранный заранее: мастер открыт из карточки партнёра */
  partnerId?: string;
  onClose: () => void;
  onSaved: (campaign: PromoCampaign) => void;
}) {
  const form = useForm<PromoCodeForm>({
    resolver: zodResolver(formSchema(limits, () => new Date(), editing)),
    defaultValues: editing === null ? { ...emptyForm(new Date()), partnerId } : formOf(editing),
    mode: "onChange",
  });
  const { errors, isSubmitting, isDirty } = form.formState;
  const values = form.watch();
  const check = useCodeCheck(editing === null && values.kind === "shared" ? values.code : "");
  const rewardLocked = editing !== null && editing.redeemed > 0;
  const startLocked = editing !== null && new Date(editing.startsAt).getTime() <= Date.now();
  const codeBlocked = editing === null && values.kind === "shared" && (check.state !== "ok" || check.result.problem !== null || check.result.taken !== null);

  const submit = form.handleSubmit(async (draft) => {
    const now = new Date();
    const result = editing === null ? await createPromoCode(api, createBodyOf(draft, now)) : await updatePromoCode(api, editing.campaignId, updateBodyOf(draft, editing, now));
    if (!result.ok) {
      if (result.error.code === "promo_code_taken") form.setError("code", { message: result.error.message });
      toast.error(result.error.message);
      return;
    }
    toast.success(editing === null ? `Промокод заведён: ${result.data.title}` : `Сохранено: ${result.data.title}`, {
      description: editing === null ? (result.data.kind === "shared" ? `Код ${result.data.codeSample} — ${rewardText(result.data.reward)}` : "Коды пачки — в карточке, там же выгрузка") : undefined,
    });
    onSaved(result.data);
    onClose();
  });

  const setEnd = (days: number) => {
    const { startsAt } = periodOf(values, new Date());
    form.setValue("endMode", "at", { shouldDirty: true });
    form.setValue("endsAt", localInput(new Date((Number.isNaN(startsAt.getTime()) ? Date.now() : startsAt.getTime()) + days * DAY_MS)), { shouldValidate: true, shouldDirty: true });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={editing === null ? "Новый промокод" : `Промокод «${editing.title}»`}
      description={editing === null ? "Пять шагов: какой код, что он даёт, когда действует, кому и как назвать. Внизу — итог." : "Вид и код не меняются после заведения — их уже могли напечатать. Нужен другой код — заведите новый."}
      footer={
        <>
          <Summary values={values} editing={editing} partner={partners.find((partner) => partner.partnerId === values.partnerId)?.name ?? null} />
          <Button onClick={onClose}>Отмена</Button>
          <Button tone="primary" type="submit" form="promo-code-form" disabled={isSubmitting || codeBlocked || Object.keys(errors).length > 0 || (editing !== null && !isDirty)}>
            {isSubmitting ? "Сохраняем…" : editing === null ? "Завести" : "Сохранить"}
          </Button>
        </>
      }
    >
      <form id="promo-code-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-6">
        <Step no={1} title="Какой код" help={HELP.promoCodes.kind}>
          <Field label="Чей код" help={HELP.promoCodes.partner}>
            <Select {...form.register("partnerId")} disabled={editing !== null} className="w-full max-w-md">
              <option value="">Команды — подарок</option>
              {partners.map((partner) => (
                <option key={partner.partnerId} value={partner.partnerId}>
                  Партнёра: {partner.name}
                </option>
              ))}
            </Select>
          </Field>
          {values.partnerId === "" ? null : (
            <Notice tone="info">
              Новичок — аккаунт не старше {bindWindowDays} дней, — которого ещё никто не пригласил, будет записан за партнёром: его игры и оплаты видны в разделе «Партнёры». Остальные получат подарок, но приведёнными не считаются.
            </Notice>
          )}
          {partners.length === 0 && editing === null ? <p className="text-xs text-text-muted">Партнёров ещё нет — их заводят в разделе «Партнёры».</p> : null}
          <Controller
            control={form.control}
            name="kind"
            render={({ field }) => (
              <ChoiceCards
                label="Вид кода"
                value={field.value}
                disabled={editing !== null}
                onChange={(next) => field.onChange(next)}
                choices={[
                  { value: "shared", title: "Один общий код", description: "Один код на всех: стрим, пост, событие. Каждый игрок активирует его один раз." },
                  { value: "batch", title: "Пачка одноразовых", description: "Уникальные коды по одному на человека: розыгрыш, призы. Выгружаются списком." },
                ]}
              />
            )}
          />

          {values.kind === "shared" ? (
            <div className="flex flex-wrap items-start gap-4">
              <div className="flex flex-col gap-1">
                <Field label="Код" help={HELP.promoCodes.code} error={errors.code?.message}>
                  <span className="flex gap-2">
                    <Input
                      {...form.register("code")}
                      disabled={editing !== null}
                      placeholder="РУБЕЖ2026"
                      autoComplete="off"
                      spellCheck={false}
                      className="w-60 font-mono uppercase tracking-wide"
                    />
                    {editing === null ? (
                      <Button type="button" onClick={() => form.setValue("code", randomCode(), { shouldValidate: true, shouldDirty: true })}>
                        Придумать
                      </Button>
                    ) : null}
                  </span>
                </Field>
                {editing === null && errors.code === undefined ? <CodeStatus check={check} /> : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-xs text-text-muted">
                  Сколько раз можно активировать
                  <Help text={HELP.promoCodes.limit} />
                </span>
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" {...form.register("unlimited", { onChange: () => void form.trigger("maxRedemptions") })} />
                  без лимита
                </label>
                {values.unlimited ? null : (
                  <Field label="Всего активаций" error={errors.maxRedemptions?.message} hint={editing === null || editing.redeemed === 0 ? undefined : `уже активировали ${formatNumber(editing.redeemed)}`}>
                    <Input type="number" min={1} step={1} {...form.register("maxRedemptions", { valueAsNumber: true })} className="w-32" />
                  </Field>
                )}
              </div>
            </div>
          ) : editing === null ? (
            <div className="flex flex-wrap items-start gap-4">
              <Field label="Сколько кодов" hint={`до ${formatNumber(limits.batchMax)}`} error={errors.count?.message}>
                <Input type="number" min={1} max={limits.batchMax} step={1} {...form.register("count", { valueAsNumber: true })} className="w-32" />
              </Field>
              <Field label="Приставка" help={HELP.promoCodes.prefix} hint={`необязательно, до ${String(limits.prefixMaxLength)} знаков`} error={errors.prefix?.message}>
                <Input {...form.register("prefix")} placeholder="ZIMA" autoComplete="off" spellCheck={false} className="w-40 font-mono uppercase" />
              </Field>
              <p className="self-center text-sm text-text-muted">
                Пример кода: <span className="font-mono text-text">{[values.prefix.trim().toUpperCase(), "K7MP", "3XTE"].filter((part) => part !== "").join("-")}</span>
              </p>
            </div>
          ) : (
            <p className="text-sm text-text-muted">
              Кодов в пачке: {formatNumber(editing.maxRedemptions ?? 0)}, использовано {formatNumber(editing.redeemed)}. Лимит пачки — число кодов.
            </p>
          )}
        </Step>

        <Step no={2} title="Что получит игрок" help={HELP.promoCodes.reward}>
          {rewardLocked ? <Notice tone="info">Код уже активировали {formatNumber(editing?.redeemed ?? 0)} раз — награду не поменять: другие игроки получили эту. Нужна другая — заведите новый код.</Notice> : null}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {REWARD_RESOURCES.map((resource) => (
              <Field key={resource} label={REWARD_TITLES[resource]} hint={`до ${formatNumber(limits.reward[resource])}`} error={errors.reward?.[resource]?.message}>
                <Input
                  type="number"
                  min={0}
                  max={limits.reward[resource]}
                  step={1}
                  disabled={rewardLocked}
                  {...form.register(`reward.${resource}`, { valueAsNumber: true, onChange: () => void form.trigger("reward") })}
                />
              </Field>
            ))}
          </div>
          <p className="text-sm">
            Игрок получит: <span className="font-medium">{rewardText(values.reward)}</span>
          </p>
        </Step>

        <Step no={3} title="Когда действует" help={HELP.promoCodes.period}>
          <div className="flex flex-wrap items-start gap-6">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-text-muted">Начало</span>
              {startLocked ? (
                <span className="text-sm">{formatDateTime(editing?.startsAt)} — уже прошло</span>
              ) : (
                <>
                  <Toggle
                    value={values.startMode}
                    options={[
                      ["now", "сразу"],
                      ["at", "с даты"],
                    ]}
                    onChange={(mode) => {
                      form.setValue("startMode", mode, { shouldDirty: true });
                      void form.trigger(["startsAt", "endsAt"]);
                    }}
                  />
                  {values.startMode === "at" ? (
                    <Field label="Дата и время" error={errors.startsAt?.message}>
                      <Input type="datetime-local" {...form.register("startsAt", { onChange: () => void form.trigger("endsAt") })} />
                    </Field>
                  ) : null}
                </>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-text-muted">Конец</span>
              <Toggle
                value={values.endMode}
                options={[
                  ["at", "до даты"],
                  ["never", "бессрочно"],
                ]}
                onChange={(mode) => {
                  form.setValue("endMode", mode, { shouldDirty: true });
                  void form.trigger("endsAt");
                }}
              />
              {values.endMode === "at" ? (
                <>
                  <Field label="Дата и время" error={errors.endsAt?.message}>
                    <Input type="datetime-local" {...form.register("endsAt")} />
                  </Field>
                  <span className="flex flex-wrap gap-1.5">
                    {QUICK_ENDS.map((quick) => (
                      <button key={quick.days} type="button" onClick={() => setEnd(quick.days)} className="rounded-pill border border-border px-2.5 py-0.5 text-xs text-text-muted hover:border-border-strong hover:text-text">
                        {quick.title}
                      </button>
                    ))}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        </Step>

        <Step no={4} title="Кому" help={HELP.promoCodes.audience}>
          <div className="flex flex-wrap gap-10 text-sm">
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-xs text-text-muted">Площадки — ни одной: все</legend>
              {platforms.map((platform) => (
                <label key={platform} className="flex items-center gap-1.5">
                  <input type="checkbox" value={platform} {...form.register("platforms")} />
                  {PLATFORM_TITLES[platform] ?? platform}
                </label>
              ))}
            </fieldset>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-xs text-text-muted">Новизна игрока</legend>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" {...form.register("newOnly", { onChange: () => void form.trigger("newPlayersDays") })} />
                только новым игрокам
              </label>
              {values.newOnly ? (
                <Field label="Аккаунт не старше, дней" hint={`до ${String(limits.newPlayersMaxDays)}`} error={errors.newPlayersDays?.message}>
                  <Input type="number" min={1} max={limits.newPlayersMaxDays} step={1} {...form.register("newPlayersDays", { valueAsNumber: true })} className="w-24" />
                </Field>
              ) : null}
            </fieldset>
          </div>
        </Step>

        <Step no={5} title="Название и тексты">
          <Field label="Название для команды" hint="игрок его не видит" error={errors.title?.message}>
            <Input {...form.register("title")} placeholder="Стрим 12 октября" maxLength={limits.titleMax + 10} className="w-full max-w-md" />
          </Field>
          <Field label={`Текст игроку после активации — ${String(values.message.trim().length)} из ${String(limits.messageMax)}`} help={HELP.promoCodes.message} error={errors.message?.message}>
            <TextArea {...form.register("message")} rows={2} placeholder="Спасибо, что смотрели стрим!" className="w-full max-w-md" />
          </Field>
          <Field label="Заметка для команды" help={HELP.promoCodes.note} error={errors.note?.message}>
            <TextArea {...form.register("note")} rows={2} placeholder="Отдали каналу «Игровой угол» на розыгрыш" className="w-full max-w-md" />
          </Field>
          <PlayerPreview values={values} />
        </Step>
      </form>
    </Dialog>
  );
}

type CheckState = { state: "idle" } | { state: "checking" } | { state: "ok"; result: CodeCheck } | { state: "failed"; message: string };

/** Проверка кода на сервере с задержкой: не на каждую букву, а когда набор затих. */
function useCodeCheck(code: string): CheckState {
  const [state, setState] = useState<CheckState>({ state: "idle" });
  useEffect(() => {
    if (code.trim() === "") {
      setState({ state: "idle" });
      return;
    }
    setState({ state: "checking" });
    let cancelled = false;
    const timer = setTimeout(() => {
      void checkCode(api, code).then((result) => {
        if (cancelled) return;
        setState(result.ok ? { state: "ok", result: result.data } : { state: "failed", message: result.error.message });
      });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);
  return state;
}

function CodeStatus({ check }: { check: CheckState }) {
  if (check.state === "idle") return <span className="text-xs text-text-disabled">Латиница, кириллица и цифры; от 4 знаков</span>;
  if (check.state === "checking") return <span className="text-xs text-text-muted">Проверяем…</span>;
  if (check.state === "failed") return <span className="text-xs text-warning">Не удалось проверить: {check.message}</span>;
  const { result } = check;
  if (result.problem !== null) return <span role="alert" className="text-xs text-danger">{result.problem}</span>;
  if (result.taken !== null) {
    return (
      <span role="alert" className="text-xs text-danger">
        Занят: «{result.taken.title}» — {result.taken.display}. Коды не переиспользуются
      </span>
    );
  }
  const lower = result.display.toLowerCase();
  const joined = result.display.replace(/[\s-]/g, "");
  const variants = [...new Set([lower, joined, result.display])].slice(0, 3);
  const layout = layoutHint(result.display);
  return (
    <span className="flex max-w-80 flex-col gap-0.5 text-xs">
      <span className="text-success">
        Свободен. Игрок может ввести: <span className="font-mono">{variants.join(", ")}</span> — регистр, пробелы и дефисы не важны
      </span>
      <span className={layout.tone === "warning" ? "text-warning" : "text-text-muted"}>{layout.text}</span>
    </span>
  );
}

function Summary({ values, editing, partner }: { values: PromoCodeForm; editing: PromoCampaign | null; partner: string | null }) {
  const now = new Date();
  const { startsAt, endsAt } = periodOf(values, now);
  const code = values.kind === "shared" ? (values.code.trim() === "" ? "код ?" : values.code.trim().toUpperCase()) : `пачка ${formatNumber(editing?.maxRedemptions ?? values.count)}`;
  const limit = values.kind === "batch" ? null : values.unlimited ? "без лимита" : `${formatNumber(values.maxRedemptions)} активаций`;
  const start = values.startMode === "now" && editing === null ? "сразу" : Number.isNaN(startsAt.getTime()) ? "?" : `с ${formatDateTime(startsAt.getTime())}`;
  const end = endsAt === null ? "бессрочно" : Number.isNaN(endsAt.getTime()) ? "?" : `до ${formatDateTime(endsAt.getTime())}`;
  return (
    <span className="mr-auto max-w-[60%] text-xs text-text-muted">
      {[code, partner === null ? null : `партнёр ${partner}`, rewardText(values.reward), limit, `${start} ${end}`].filter((part) => part !== null).join(" · ")}
    </span>
  );
}

/** Как игрок увидит ответ на ввод — чтобы текст проверили глазами до заведения. */
function PlayerPreview({ values }: { values: PromoCodeForm }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">Игрок увидит после ввода</span>
      <div className="max-w-xs rounded-md border border-border bg-surface-sunken px-4 py-3 text-center">
        <p className="text-sm font-semibold">Промокод активирован</p>
        <p className="mt-1 text-sm text-accent">{rewardText(values.reward)}</p>
        <p className="mt-1 text-xs text-text-muted">{values.message.trim() === "" ? "Награда уже в кошельке" : values.message.trim()}</p>
      </div>
    </div>
  );
}

function Toggle<T extends string>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void }) {
  return (
    <span className="inline-flex w-fit rounded-sm border border-border p-0.5">
      {options.map(([option, title]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`rounded-sm px-3 py-1 text-xs ${value === option ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text"}`}
        >
          {title}
        </button>
      ))}
    </span>
  );
}

function Step({ no, title, help, children }: { no: number; title: string; help?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-accent/15 text-xs text-accent">{no}</span>
        {title}
        {help === undefined ? null : <Help text={help} />}
      </h3>
      {children}
    </section>
  );
}
