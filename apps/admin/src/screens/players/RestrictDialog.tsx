import { useEffect, useMemo, useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import {
  BAN_KIND,
  COMMENT_MAX,
  draftProblem,
  emptyDraft,
  endsAtOf,
  imposeBody,
  imposeRestriction,
  notifyOf,
  previewRestriction,
  submitLabel,
  TERMS,
  type RestrictDraft,
  type Restriction,
  type RestrictionCatalog,
  type RestrictionKindInfo,
  type RestrictionPreview,
  type TermId,
} from "../../api/restrictions";
import { formatDateTime } from "../../format";
import { ChoiceCards } from "../../ui/choice";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, Field, Input, Notice, Select, TextArea } from "../../ui/kit";
import { toast } from "../../ui/toast";

/**
 * «Ограничить игрока» (docs/35-stage4-plan.md WP44, О40): что закрыть — с
 * тем, что игрок потеряет; на сколько — кнопками; причина — шаблоном, её
 * текст видит игрок, а комментарий остаётся команде. Ниже — что именно
 * игрок увидит, словами сервера (Р83), и кнопка говорит, что случится.
 */
export function RestrictDialog({
  open,
  onOpenChange,
  playerName,
  accountId,
  catalog,
  active,
  canBan,
  canRestrict,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playerName: string;
  accountId: string;
  catalog: RestrictionCatalog;
  active: readonly Restriction[];
  canBan: boolean;
  canRestrict: boolean;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<RestrictDraft>(emptyDraft);
  // Срок «на 3 дня» считается от открытия: иначе предпросмотр спрашивал бы сервер на каждой перерисовке.
  const [now, setNow] = useState(() => new Date());
  const [preview, setPreview] = useState<RestrictionPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(emptyDraft());
    setNow(new Date());
    setPreview(null);
    setError(null);
  }, [open]);

  const set = (patch: Partial<RestrictDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const banned = draft.kinds.includes(BAN_KIND);
  const endsAt = endsAtOf(draft, now);
  const notify = notifyOf(draft);

  // Что увидит игрок — со слов сервера; спрашиваем, когда черновику есть что показать.
  const kindsKey = draft.kinds.join(",");
  const previewBody = useMemo(
    () => (kindsKey === "" || draft.reason === "" || endsAt === undefined ? null : { kinds: kindsKey.split(","), endsAt, reason: draft.reason, notify }),
    [kindsKey, endsAt, draft.reason, notify],
  );
  useEffect(() => {
    setPreview(null);
    if (previewBody === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void previewRestriction(api, previewBody).then((result) => {
        if (!cancelled) setPreview(result.ok ? result.data : null);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [previewBody]);

  const toggle = (kind: string, checked: boolean) => {
    if (kind === BAN_KIND) return set({ kinds: checked ? [BAN_KIND] : [] });
    set({ kinds: checked ? [...draft.kinds.filter((item) => item !== kind), kind] : draft.kinds.filter((item) => item !== kind) });
  };

  const problem = draftProblem(draft, now) ?? preview?.problem ?? null;
  const ready = problem === null && preview !== null && previewBody !== null;

  const submit = async () => {
    // Срок «на N дней» — от нажатия, а не от открытия диалога.
    const body = imposeBody(draft, new Date());
    if (body === null) return;
    setPending(true);
    setError(null);
    const result = await imposeRestriction(api, accountId, body);
    setPending(false);
    if (!result.ok) return setError(result.error);
    const titles = result.data.restrictions.map((row) => row.title).join(", ");
    toast.success(banned ? "Игрок заблокирован" : "Ограничение наложено", {
      description: banned ? `Отозвано сессий: ${String(result.data.revokedSessions)}` : `${titles} — ${body.endsAt === null ? "бессрочно" : `до ${formatDateTime(body.endsAt)}`}`,
    });
    onOpenChange(false);
    onDone();
  };

  const kinds = catalog.kinds.filter((item) => item.kind !== BAN_KIND);
  const ban = catalog.kinds.find((item) => item.kind === BAN_KIND);
  const reason = catalog.reasons.find((item) => item.reason === draft.reason);
  const activeOf = (kind: string) => active.find((row) => row.kind === kind && row.state === "active");

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Ограничить: ${playerName}`}
      description="Закройте то, чем игрок злоупотребил, на срок — остальное останется как было."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button tone="danger" disabled={!ready || pending} onClick={() => void submit()}>
            {pending ? "Накладываем…" : submitLabel(draft, now)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Что закрыть</h3>
          {canRestrict ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {kinds.map((item) => (
                <KindOption key={item.kind} info={item} checked={draft.kinds.includes(item.kind)} disabled={banned} active={activeOf(item.kind)} onChange={(checked) => toggle(item.kind, checked)} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-muted">Закрывать отдельные функции может модератор — у вас есть только блокировка целиком.</p>
          )}
          {banned ? <p className="text-xs text-text-muted">Блокировка закрывает всё — отдельные функции отмечать не нужно.</p> : null}
          {canBan && ban !== undefined ? (
            <>
              {canRestrict ? <h4 className="mt-1 text-xs font-medium text-text-muted">Или — всё сразу</h4> : null}
              <KindOption info={ban} checked={banned} disabled={false} danger active={activeOf(BAN_KIND)} onChange={(checked) => toggle(BAN_KIND, checked)} />
            </>
          ) : null}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">На сколько</h3>
          <ChoiceCards<TermId> label="Срок" value={draft.term} columns={3} choices={TERMS.map((term) => ({ value: term.id, title: term.title }))} onChange={(term) => set({ term })} />
          {draft.term === "date" ? (
            <Field label="До какого момента" hint="Время — по часам вашего компьютера; игрок увидит его по Москве — смотрите ниже, что он прочтёт.">
              <Input type="datetime-local" value={draft.until} onChange={(event) => set({ until: event.target.value })} />
            </Field>
          ) : null}
          {draft.term !== "date" && endsAt !== undefined ? (
            <p className="text-xs text-text-muted">{endsAt === null ? "Пока не снимут из панели." : `Снимется само ${formatDateTime(endsAt)} — задача проверяет сроки раз в минуту.`}</p>
          ) : null}
        </section>

        <section className="flex flex-col gap-3">
          <Field label="Причина" help={HELP.players.restrictReason}>
            <Select value={draft.reason} onChange={(event) => set({ reason: event.target.value })}>
              <option value="">— выберите —</option>
              {catalog.reasons.map((item) => (
                <option key={item.reason} value={item.reason}>
                  {item.title}
                </option>
              ))}
            </Select>
          </Field>
          {reason === undefined ? null : <p className="-mt-1 text-xs text-text-muted">Игрок прочтёт: «{reason.player}»</p>}
          <Field label="Комментарий для команды" hint={`Игрок его не увидит. ${String(draft.comment.trim().length)} из ${String(COMMENT_MAX)}.`}>
            <TextArea rows={3} maxLength={COMMENT_MAX} value={draft.comment} placeholder="Что именно случилось: ссылки на забеги, сколько кодов, с каких аккаунтов" onChange={(event) => set({ comment: event.target.value })} />
          </Field>
        </section>

        <section className="flex flex-col gap-1.5">
          <label className={`flex items-center gap-2 text-sm ${banned ? "text-text-muted" : "cursor-pointer"}`}>
            <input type="checkbox" checked={notify} disabled={banned} onChange={(event) => set({ notify: event.target.checked })} />
            Сообщить игроку
          </label>
          <p className="text-xs text-text-muted">
            {banned
              ? "Блокировку игрок видит при входе — молча её не наложить."
              : notify
                ? "Там, где игрок упрётся, он увидит, что закрыто, до какого числа и почему."
                : "Молча: в закрытом игрок увидит нейтральное «недоступно», как при сбое; в рейтинге — тень, он видит себя на своём месте."}
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Что увидит игрок</h3>
          {previewBody === null ? (
            <p className="text-xs text-text-muted">Отметьте, что закрыть, срок и причину — здесь появится текст, который получит игрок.</p>
          ) : preview === null ? (
            <p className="text-xs text-text-muted">Спрашиваем сервер…</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {preview.shown.map((item) => (
                <li key={item.kind} className="rounded-sm border border-border bg-surface-sunken px-3 py-2">
                  <div className="text-xs text-text-muted">{item.title}</div>
                  <div className="text-sm">{item.text}</div>
                </li>
              ))}
            </ul>
          )}
          {problem !== null && previewBody !== null ? <Notice tone="warning">{problem}</Notice> : null}
        </section>

        {error === null ? null : <Notice>{error.message}</Notice>}
      </div>
    </Dialog>
  );
}

function KindOption({
  info,
  checked,
  disabled,
  danger = false,
  active,
  onChange,
}: {
  info: RestrictionKindInfo;
  checked: boolean;
  disabled: boolean;
  danger?: boolean;
  active: Restriction | undefined;
  onChange: (checked: boolean) => void;
}) {
  const tone = checked ? (danger ? "border-danger bg-danger/10" : "border-accent bg-accent/10") : "border-border bg-surface-sunken hover:border-border-strong";
  return (
    <label className={`flex items-start gap-3 rounded-sm border px-3 py-2.5 ${tone} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-1 shrink-0" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {danger ? `Заблокировать целиком` : info.title}
          {active === undefined ? null : <Badge tone="warning">{active.endsAt === null ? "уже закрыто бессрочно" : `уже закрыто до ${formatDateTime(active.endsAt)}`}</Badge>}
        </span>
        <span className="text-xs leading-snug text-text-muted">{info.effect}</span>
        {active !== undefined && checked ? <span className="text-xs text-warning">Новое заменит действующее — с этим сроком и причиной.</span> : null}
      </span>
    </label>
  );
}
