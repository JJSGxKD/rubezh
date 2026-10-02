import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import { conversion, createLink, fetchLinks, freshRow, NETWORK_TITLES, SLUG, summaryLine, type Link, type LinkRow, type RegistrationOn } from "../../api/links";
import { formatDateTime, formatNumber } from "../../format";
import { ChoiceCards } from "../../ui/choice";
import { Badge, Button, DataTable, ErrorNotice, Field, Help, Input, Loading, Notice, Panel } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { navigate } from "../../ui/router";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { LinkCard } from "./LinkCard";
import { TokenNotice } from "./TokenNotice";

/**
 * Ссылки кампаний: завести ссылку `/r/<код>` для поста, канала, партнёра
 * или закупки в рекламной сети и видеть клики и запуски по ней. Клики
 * краулеров превью сюда не попадают. Ссылка сети вдобавок отдаёт сети
 * регистрации и покупки пришедших новичков (WP43) — карточка ссылки
 * показывает адрес для кабинета и журнал отправленного. Карточка
 * открывается и по адресу `#/links/<код>`: на неё ведёт журнал аудита.
 */

type Placement = "plain" | "adsgram";

export function LinksScreen({ id }: { id: string | null }) {
  const { state, reload } = useApi(() => fetchLinks(api), []);
  const [placement, setPlacement] = useState<Placement>("plain");
  const [registrationOn, setRegistrationOn] = useState<RegistrationOn>("first_run");
  const [campaign, setCampaign] = useState("");
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [openCode, setOpenCode] = useState<string | null>(id);
  const [created, setCreated] = useState<Link | null>(null);

  useEffect(() => setOpenCode(id), [id]);

  const valid = SLUG.test(campaign) && (source === "" || SLUG.test(source));

  const choosePlacement = (next: Placement) => {
    setPlacement(next);
    // Источник ссылки сети почти всегда — сама сеть; подставляем, но не перетираем написанное.
    if (next !== "plain" && source === "") setSource(next);
    if (next === "plain" && source === "adsgram") setSource("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const network = placement === "plain" ? undefined : placement;
    const result = await createLink(api, {
      campaign,
      source: source || undefined,
      note: note.trim() || undefined,
      ...(network === undefined ? {} : { network, registrationOn }),
    });
    if (!result.ok) return setError(result.error);
    setError(null);
    setCreated(result.data);
    setCampaign("");
    setSource("");
    setNote("");
    setPlacement("plain");
    toast.success(network === undefined ? "Ссылка заведена" : "Ссылка заведена — вставьте адрес с метками в кабинет сети");
    reload();
    // Сразу карточка: адрес нужен прямо сейчас, а у ссылки сети — ещё и инструкция к кабинету.
    navigate({ section: "links", id: result.data.code });
  };

  const close = () => {
    setOpenCode(null);
    if (id !== null) navigate({ section: "links", id: null });
  };

  const links = state.status === "ok" ? state.data.links : [];
  const open = links.find((link) => link.code === openCode) ?? (created !== null && created.code === openCode ? freshRow(created) : null);
  const adsgramToken = state.status === "ok" ? state.data.postback.adsgramToken : true;

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Новая ссылка">
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <ChoiceGroup label="Где размещается" help={HELP.links.network}>
            <ChoiceCards<Placement>
              label="Где размещается"
              value={placement}
              onChange={choosePlacement}
              choices={[
                { value: "plain", title: "Пост, канал, партнёр", description: "Считаем клики и запуски игры. Ничего никуда не отправляем." },
                {
                  value: "adsgram",
                  title: "Закупка в AdsGram",
                  description: "Плюс адрес с метками для кабинета AdsGram: регистрации и покупки пришедших новичков уйдут в сеть, и она будет приводить тех, кто играет и платит.",
                },
              ]}
            />
          </ChoiceGroup>
          {placement === "plain" ? null : (
            <>
              <ChoiceGroup label="Что считать регистрацией" help={HELP.links.registrationOn}>
                <ChoiceCards<RegistrationOn>
                  label="Что считать регистрацией"
                  value={registrationOn}
                  onChange={setRegistrationOn}
                  choices={[
                    {
                      value: "first_run",
                      title: "Первый забег от 30 секунд",
                      aside: <Badge tone="accent">советуем</Badge>,
                      description: "Сеть учится на тех, кто правда играет. Засчитываем в течение 7 дней после клика.",
                    },
                    { value: "launch", title: "Первый запуск игры", description: "Конверсий больше и обучение быстрее, но сеть начнёт приводить и тех, кто открыл и закрыл." },
                  ]}
                />
              </ChoiceGroup>
              {adsgramToken ? null : (
                <div className="max-w-3xl">
                  <TokenNotice />
                </div>
              )}
            </>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Кампания" hint="латиница, цифры, дефис" help={HELP.links.campaign}>
              <Input value={campaign} onChange={(event) => setCampaign(event.target.value.trim().toLowerCase())} placeholder="launch-post" maxLength={64} />
            </Field>
            <Field label="Источник" help={HELP.links.source}>
              <Input value={source} onChange={(event) => setSource(event.target.value.trim().toLowerCase())} placeholder="tg-channel" maxLength={64} />
            </Field>
            <Field label="Заметка">
              <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} className="w-72" />
            </Field>
            <Button tone="primary" type="submit" disabled={!valid}>
              Завести
            </Button>
          </div>
        </form>
        {error === null ? null : (
          <div className="mt-3">
            <Notice>{error.message}</Notice>
          </div>
        )}
      </Panel>
      <Panel title="Ссылки" help={HELP.links.links} actions={<Button onClick={reload}>Обновить</Button>}>
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {state.status === "ok" ? (
          <DataTable
            rows={links}
            rowKey={(row) => row.code}
            empty="Ссылок ещё нет"
            onRowClick={(row) => navigate({ section: "links", id: row.code })}
            columns={[
              {
                title: "Кампания",
                render: (row) => (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {row.campaign}
                    {row.network === null ? null : <Badge tone="accent">{NETWORK_TITLES[row.network]}</Badge>}
                  </span>
                ),
              },
              { title: "Источник", render: (row) => row.source ?? "—" },
              { title: "Адрес", render: (row) => <code className="text-xs">{row.url}</code> },
              { title: "Кликов", render: (row) => formatNumber(row.clicks), align: "right" },
              { title: "За 30 дней", render: (row) => formatNumber(row.clicks30d), align: "right" },
              { title: "Запусков", help: HELP.links.launches, render: (row) => formatNumber(row.launches), align: "right" },
              { title: "Клик → запуск", help: HELP.links.conversion, render: (row) => (conversion(row) === null ? "—" : `${conversion(row)}%`), align: "right" },
              { title: "Отдано сети", help: HELP.links.networkConversions, render: (row) => <NetworkCell row={row} /> },
              { title: "Заведена", render: (row) => formatDateTime(row.createdAt) },
              { title: "Заметка", render: (row) => row.note ?? "—" },
            ]}
          />
        ) : null}
      </Panel>
      {openCode === null ? null : (
        <LinkCard
          link={open}
          loading={state.status === "loading"}
          adsgramToken={adsgramToken}
          onClose={close}
          onChanged={reload}
        />
      )}
    </div>
  );
}

/**
 * Подпись над карточками выбора. Не `Field`: тот — `<label>`, и щелчок по
 * подписи или по «?» выбирал бы первую карточку.
 */
function ChoiceGroup({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <div className="flex max-w-3xl flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-text-muted">
        {label}
        <Help text={help} />
      </span>
      {children}
    </div>
  );
}

/** Сколько регистраций и покупок отдано сети; что не ушло — сразу видно в списке. */
function NetworkCell({ row }: { row: LinkRow }) {
  if (row.conversions === null) return <span className="text-text-muted">—</span>;
  const line = summaryLine(row.conversions);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 whitespace-nowrap">
      <span>
        рег. {formatNumber(line.registrations)} · пок. {formatNumber(line.purchases)}
      </span>
      {line.failed > 0 ? <Badge tone="danger">не ушло {formatNumber(line.failed)}</Badge> : null}
      {line.waiting > 0 ? <Badge tone="warning">ждёт {formatNumber(line.waiting)}</Badge> : null}
    </span>
  );
}
