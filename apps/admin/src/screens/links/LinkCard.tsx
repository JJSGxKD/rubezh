import { useEffect, useState } from "react";
import { api } from "../../services";
import {
  conversion,
  conversionState,
  fetchConversions,
  GOAL_TITLES,
  GOALS,
  goalCounts,
  NETWORK_TITLES,
  resendConversion,
  type Conversion,
  type ConversionSummary,
  type LinkRow,
} from "../../api/links";
import type { ApiError } from "../../api/client";
import { formatDateTime, formatNumber } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Help, KeyValue, Loading, Notice } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { toast } from "../../ui/toast";
import { TokenNotice } from "./TokenNotice";

/**
 * Карточка ссылки. У обычной — адрес и цифры. У ссылки сети главное —
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
  const title = link === null ? "Ссылка" : link.campaign;
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
  return (
    <div className="flex flex-col gap-5">
      {link.network === null || link.networkUrl === null ? (
        <AddressBox label="Адрес ссылки" url={link.url} primary />
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
        </section>
      )}

      <KeyValue
        items={[
          ["Кликов", `${formatNumber(link.clicks)}, за 30 дней — ${formatNumber(link.clicks30d)}`],
          ["Запусков", formatNumber(link.launches), HELP.links.launches],
          ["Клик → запуск", rate === null ? "—" : `${rate}%`, HELP.links.conversion],
        ]}
      />

      {link.conversions === null ? null : (
        <>
          <GoalTable summary={link.conversions} />
          <Journal code={link.code} onChanged={onChanged} />
        </>
      )}
    </div>
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
