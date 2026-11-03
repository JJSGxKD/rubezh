import { useEffect, useState } from "react";
import { api } from "../../services";
import {
  AUTO_SOURCE_HELP,
  autoPairs,
  conversion,
  conversionState,
  deviceRows,
  DIRECT_HINT,
  DIRECT_UNAVAILABLE,
  fetchConversions,
  GOAL_TITLES,
  GOALS,
  goalCounts,
  linkTitle,
  LINK_TARGETS,
  NETWORK_NO_DIRECT,
  NETWORK_TITLES,
  OWNER_HELP,
  OWNER_TITLES,
  RENAME_HELP,
  renameLink,
  resendConversion,
  retargetLink,
  setLinkHidden,
  TARGET_HELP,
  TARGET_HINTS,
  TARGET_TITLES,
  TITLE_MAX,
  type Conversion,
  type ConversionSummary,
  type LinkPartner,
  type LinkRow,
  type LinkTarget,
} from "../../api/links";
import type { ApiError } from "../../api/client";
import { formatDateTime, formatNumber } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Help, Input, KeyValue, Loading, Notice, Select } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { toast } from "../../ui/toast";
import { TokenNotice } from "./TokenNotice";

/**
 * Карточка ссылки. У обычной — адрес переходника, прямая ссылка без него и
 * цифры; цель (Mini App, бот, лендинг) меняется здесь же, а владелец —
 * наша команда или партнёр (T-0067) — только показывается. У ссылки сети главное —
 * адрес с метками для кабинета и путь от клика до конверсии: что вставить в
 * кабинет, что считается регистрацией и покупкой, что ушло в сеть и что нет.
 */
export function LinkCard({
  link,
  loading,
  adsgramToken,
  onClose,
  onChanged,
}: {
  /** `null` — список ещё грузится или ссылки с таким кодом нет */
  link: LinkRow | null;
  loading: boolean;
  adsgramToken: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const title = link === null ? "Ссылка" : linkTitle(link);
  const description = link === null ? undefined : `${link.source ?? "без источника"} · заведена ${formatDateTime(link.createdAt)}${link.note === null ? "" : ` · ${link.note}`}`;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())} title={title} {...(description === undefined ? {} : { description })}>
      {link === null ? (
        loading ? <Loading /> : <Notice>Ссылки с таким кодом нет среди последних 200 — проверьте адрес.</Notice>
      ) : (
        <CardBody link={link} adsgramToken={adsgramToken} onChanged={onChanged} />
      )}
    </Dialog>
  );
}

function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} скопирован`),
    () => toast.error("Браузер не дал скопировать — выделите вручную"),
  );
}

function CardBody({ link, adsgramToken, onChanged }: { link: LinkRow; adsgramToken: boolean; onChanged: () => void }) {
  const rate = conversion(link);
  const devices = deviceRows(link.devices);
  return (
    <div className="flex flex-col gap-5">
      {link.network === null || link.networkUrl === null ? (
        <section className="flex flex-col gap-3">
          <AddressBox label="Адрес ссылки" url={link.url} primary />
          {link.directUrl === null ? (
            <p className="text-xs text-text-muted">{DIRECT_UNAVAILABLE}</p>
          ) : (
            <AddressBox label="Прямая ссылка" url={link.directUrl} hint={DIRECT_HINT} />
          )}
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          <AddressBox label={`Адрес для кабинета ${NETWORK_TITLES[link.network]}`} url={link.networkUrl} primary />
          <ol className="list-decimal space-y-1 pl-5 text-sm text-text-muted">
            <li>
              В кампании AdsGram вставьте этот адрес в поле ссылки <span className="text-text">целиком, вместе с метками в фигурных скобках</span> — сеть сама
              подставит в них данные клика.
            </li>
            <li>
              Токен конверсий из кабинета AdsGram задаётся один раз на все ссылки, в «Ключах интеграций».{" "}
              {adsgramToken ? <Badge tone="success">задан</Badge> : null}
            </li>
            <li>
              Регистрация уходит в сеть {link.registrationOn === "launch" ? "при первом запуске игры" : "после первого забега от 30 секунд, если он был в течение 7 дней после клика"}. Первая
              покупка — отдельной целью, следующие — повторными; возвраты и тестовые оплаты не уходят.
            </li>
          </ol>
          {adsgramToken ? null : <TokenNotice />}
          <AddressBox label="Адрес без меток — для проверки" url={link.url} hint="Переход по нему засчитается кликом, но в сеть не уйдёт: сеть не знает такого клика." />
          <p className="text-xs text-text-muted">{NETWORK_NO_DIRECT}</p>
        </section>
      )}

      {link.auto ? <AutoSource link={link} onChanged={onChanged} /> : null}

      <KeyValue
        items={[
          ["Чья ссылка", <Owner key="owner" partner={link.partner} />, OWNER_HELP],
          ["Куда ведёт", <TargetEditor key="target" link={link} onChanged={onChanged} />, TARGET_HELP],
          ["Кликов", `${formatNumber(link.clicks)}, за 30 дней — ${formatNumber(link.clicks30d)}`, HELP.links.clicks],
          ["Запусков через переходник", formatNumber(link.launches), HELP.links.launches],
          ["Запусков по прямой ссылке", formatNumber(link.directLaunches), DIRECT_HINT],
          ["Клик → запуск", rate === null ? "—" : `${rate}%`, HELP.links.conversion],
        ]}
      />

      {devices.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Клики по устройствам</h3>
          <KeyValue
            items={devices.map((row): [string, string] | [string, string, string] =>
              row.key === "unknown" ? [row.title, formatNumber(row.count), HELP.links.deviceUnknown] : [row.title, formatNumber(row.count)],
            )}
          />
        </section>
      )}

      {link.conversions === null ? null : (
        <>
          <GoalTable summary={link.conversions} />
          <Journal code={link.code} onChanged={onChanged} />
        </>
      )}
    </div>
  );
}

/**
 * «Завёлся сам»: источник, который сервер завёл по ссылке с метками (Р116). Название можно поменять, а источник
 * скрыть — запуски по нему считаются как раньше, кампания и источник в аналитике не меняются.
 */
function AutoSource({ link, onChanged }: { link: LinkRow; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [saving, setSaving] = useState(false);
  const hidden = link.hiddenAt !== null;
  const pairs = autoPairs(link);

  const toggle = async () => {
    setSaving(true);
    const result = await setLinkHidden(api, link.code, !hidden);
    setSaving(false);
    if (!result.ok) return toast.error(result.error.message);
    toast.success(hidden ? "Источник вернулся в список" : "Источник скрыт — запуски по нему считаются как раньше");
    onChanged();
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        Завёлся сам
        <Badge>авто</Badge>
        {hidden ? <Badge tone="warning">скрыта</Badge> : null}
        <Help text={AUTO_SOURCE_HELP} />
      </h3>
      <KeyValue items={[...pairs.map(({ label, value }): [string, string] => [label, value]), ["Завёлся", formatDateTime(link.createdAt)]]} />
      <p className="text-xs text-text-muted">{AUTO_SOURCE_HELP}</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setRenaming(true)} disabled={saving}>
          Переименовать
        </Button>
        <Button onClick={() => void toggle()} disabled={saving}>
          {hidden ? "Вернуть в список" : "Скрыть"}
        </Button>
      </div>
      {renaming ? <RenameDialog link={link} onClose={() => setRenaming(false)} onChanged={onChanged} /> : null}
    </section>
  );
}

/** Название источника: 80 знаков, «Сбросить» возвращает кампанию. Ошибка остаётся в окне, поле не сбрасывается. */
function RenameDialog({ link, onClose, onChanged }: { link: LinkRow; onClose: () => void; onChanged: () => void }) {
  const [value, setValue] = useState(link.title ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const save = async (title: string) => {
    setSaving(true);
    const result = await renameLink(api, link.code, title);
    setSaving(false);
    if (!result.ok) return setError(result.error);
    toast.success(title.trim() === "" ? `Название сброшено — в списке «${link.campaign}»` : "Название сохранено");
    onChanged();
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Название источника"
      description={`Кампания «${link.campaign}» и источник в аналитике не меняются`}
      footer={
        <>
          <Button onClick={() => void save("")} disabled={saving || link.title === null}>
            Сбросить
          </Button>
          <Button onClick={onClose}>Отмена</Button>
          <Button tone="primary" onClick={() => void save(value)} disabled={saving || value.trim().length > TITLE_MAX}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Input aria-label="Название источника" value={value} onChange={(event) => setValue(event.target.value)} placeholder={link.campaign} maxLength={TITLE_MAX + 10} className="w-full" />
        <span className="text-xs text-text-muted">
          {String(value.trim().length)} из {String(TITLE_MAX)}. {RENAME_HELP}
        </span>
        {error === null ? null : <ErrorNotice error={error} />}
      </div>
    </Dialog>
  );
}

/** Владелец: «Наша» или партнёр, чья карточка открывается по имени. Менять нельзя — клики и привязки уже за ним. */
function Owner({ partner }: { partner: LinkPartner | null }) {
  if (partner === null) return <span>{OWNER_TITLES.own}</span>;
  return (
    <span className="flex flex-col items-start gap-0.5">
      <button type="button" className="text-accent hover:underline" onClick={() => navigate({ section: "partners", id: partner.partnerId })}>
        {partner.name}
      </button>
      <span className="text-xs text-text-muted">Пришедшие по ссылке новички записываются за партнёром. Владельца не сменить.</span>
    </span>
  );
}

/** Цель ссылки выбором: сменилась — прошлые клики остаются, новые идут по-новому. */
function TargetEditor({ link, onChanged }: { link: LinkRow; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);

  const change = async (target: LinkTarget) => {
    if (target === link.target) return;
    setSaving(true);
    const result = await retargetLink(api, link.code, target);
    setSaving(false);
    if (!result.ok) return toast.error(result.error.message);
    toast.success(`Теперь ссылка ведёт: ${TARGET_TITLES[target]}`);
    onChanged();
  };

  return (
    <span className="flex flex-col items-start gap-1">
      <Select
        aria-label="Куда ведёт ссылка"
        value={link.target}
        disabled={saving}
        onChange={(event) => {
          const next = LINK_TARGETS.find((target) => target === event.target.value);
          if (next !== undefined) void change(next);
        }}
      >
        {LINK_TARGETS.map((target) => (
          <option key={target} value={target}>
            {TARGET_TITLES[target]}
          </option>
        ))}
      </Select>
      <span className="text-xs text-text-muted">{TARGET_HINTS[link.target]}</span>
    </span>
  );
}

function AddressBox({ label, url, primary = false, hint }: { label: string; url: string; primary?: boolean; hint?: string }) {
  return (
    <section className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">{label}</span>
      <div className="flex items-start gap-2 rounded-sm border border-border bg-surface-sunken px-3 py-2">
        {/* Адрес с метками длинный — переносится где угодно, но копируется целиком кнопкой. */}
        <code className="min-w-0 flex-1 font-mono text-xs break-all select-all">{url}</code>
        <Button tone={primary ? "primary" : "secondary"} onClick={() => copy(url, "Адрес")}>
          Скопировать
        </Button>
      </div>
      {hint === undefined ? null : <span className="text-xs text-text-muted">{hint}</span>}
    </section>
  );
}

/** Счёт по целям: что ушло, ждёт, не ушло и пропущено. */
function GoalTable({ summary }: { summary: ConversionSummary }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        Отдано сети
        <Help text={HELP.links.networkConversions} />
      </h3>
      <DataTable
        rows={GOALS}
        rowKey={(goal) => String(goal)}
        columns={[
          { title: "Цель", render: (goal) => GOAL_TITLES[goal] },
          { title: "Ушло", render: (goal) => formatNumber(goalCounts(summary, goal).sent), align: "right" },
          { title: "Ждёт", render: (goal) => formatNumber(goalCounts(summary, goal).pending), align: "right" },
          { title: "Не ушло", render: (goal) => <Count value={goalCounts(summary, goal).failed} tone="danger" />, align: "right" },
          { title: "Пропущено", render: (goal) => formatNumber(goalCounts(summary, goal).skipped), align: "right" },
        ]}
      />
    </section>
  );
}

function Count({ value, tone }: { value: number; tone: "danger" }) {
  return value === 0 ? <>0</> : <Badge tone={tone}>{formatNumber(value)}</Badge>;
}

/** Журнал конверсий ссылки, новые сверху, страницами по 50. */
function Journal({ code, onChanged }: { code: string; onChanged: () => void }) {
  const view = useSession((session) => session.view);
  const canOpenPlayer = can(view, "players.view");
  const [rows, setRows] = useState<Conversion[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "more">("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  const load = async (before: string | null) => {
    setStatus(before === null ? "loading" : "more");
    const result = await fetchConversions(api, code, before);
    setStatus("ok");
    if (!result.ok) return setError(result.error);
    setError(null);
    setRows((current) => (before === null ? result.data.conversions : [...current, ...result.data.conversions]));
    setNext(result.data.next);
  };

  useEffect(() => {
    // Журнал перечитывается при смене ссылки, а не при каждой новой функции загрузки.
    void load(null);
  }, [code]);

  const resend = async (row: Conversion) => {
    setSending(row.conversionId);
    const result = await resendConversion(api, code, row.conversionId);
    setSending(null);
    if (!result.ok) return toast.error(result.error.message);
    toast.success("Конверсия в очереди — уйдёт в течение минуты");
    setRows((current) => current.map((item) => (item.conversionId === row.conversionId ? result.data : item)));
    onChanged();
  };

  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          Журнал
          <Help text={HELP.links.journal} />
        </h3>
        <Button onClick={() => void load(null)} disabled={status !== "ok"}>
          Обновить
        </Button>
      </header>
      {error === null ? null : <ErrorNotice error={error} onRetry={() => void load(null)} />}
      {status === "loading" ? (
        <Loading />
      ) : (
        <DataTable
          rows={rows}
          rowKey={(row) => row.conversionId}
          empty="Конверсий ещё нет. Первая появится, когда новичок из рекламы пройдёт регистрацию."
          columns={[
            { title: "Когда", render: (row) => <span className="whitespace-nowrap">{formatDateTime(row.createdAt)}</span> },
            { title: "Цель", render: (row) => <span className="whitespace-nowrap">{GOAL_TITLES[row.goal]}</span> },
            {
              title: "Что с ней",
              render: (row) => {
                const state = conversionState(row);
                return (
                  <span className="flex flex-col items-start gap-0.5">
                    <Badge tone={state.tone}>{state.title}</Badge>
                    <span className="text-xs text-text-muted">{state.detail}</span>
                  </span>
                );
              },
            },
            {
              title: "Игрок",
              render: (row) =>
                canOpenPlayer ? (
                  <button type="button" className="text-xs text-accent hover:underline" onClick={() => navigate({ section: "players", id: row.accountId })}>
                    карточка
                  </button>
                ) : (
                  <code className="text-xs">{row.accountId.slice(0, 8)}</code>
                ),
            },
            {
              title: "",
              render: (row) =>
                conversionState(row).resendable ? (
                  <Button className="whitespace-nowrap" disabled={sending !== null} onClick={() => void resend(row)}>
                    {sending === row.conversionId ? "Ставлю…" : "Отправить"}
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      {next === null ? null : (
        <div>
          <Button disabled={status !== "ok"} onClick={() => void load(next)}>
            {status === "more" ? "Загрузка…" : "Показать ещё"}
          </Button>
        </div>
      )}
    </section>
  );
}
