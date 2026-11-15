import { useEffect, useState, type ReactNode } from "react";
import { fetchXrayCore, refreshXrayCore, updateXrayCore, type XrayCoreView } from "../../api/xray-core";
import { formatDateTime } from "../../format";
import { hrefOf } from "../../routes";
import { api } from "../../services";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, ErrorNotice, KeyValue, Loading, Notice, Panel } from "../../ui/kit";
import { toast, toastError } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { blockedText, compatibilityText, runningNote, runText, testedRangeText, type Tone } from "./xray-core-view";

/**
 * Вкладка «Ядро Xray» раздела «Прокси» (docs/35-stage4-plan.md Р202, Р201,
 * tasks/T-0418): какая версия запущена, что вышло у XTLS и подойдёт ли оно
 * нашему конфигу. «Проверить сейчас» и «Обновить» — только у владельца
 * (`proxies.edit`); остальным видны те же сведения. Что можно нажать, решает
 * сервер (`update.blockedBy`), панель только называет причину. Пока идёт запуск
 * workflow, состояние перечитывается раз в 15 секунд; со вкладки ушли — опрос
 * остановился вместе с компонентом.
 */

const POLL_MS = 15_000;

/** Цвет текста по смыслу; смысл при этом всегда назван и словами. */
const TEXT_TONES: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-text-muted",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

export function XrayCorePanel({ canEdit }: { canEdit: boolean }) {
  const { state, reload } = useApi(() => fetchXrayCore(api), []);
  /** ответ кнопок свежее загруженного: показывается, пока не придёт следующее чтение */
  const [fresh, setFresh] = useState<XrayCoreView | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const loaded = state.status === "ok" ? state.data : null;
  useEffect(() => {
    setFresh(null);
  }, [loaded]);

  const view = fresh ?? loaded;
  const polling = view?.update.lastRun?.active === true;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, reload]);

  if (view === null) {
    if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
    return <Loading />;
  }

  const { running, latest, update } = view;
  const note = runningNote(running);
  const runningCompat = running.compatibility === null ? null : compatibilityText(running.compatibility);
  const latestCompat = latest === null ? null : compatibilityText(latest.compatibility);

  const check = async () => {
    setChecking(true);
    const result = await refreshXrayCore(api);
    setChecking(false);
    if (!result.ok) return void toastError(result.error);
    setFresh(result.data);
  };

  return (
    <>
      <Panel
        title="Ядро Xray"
        help={HELP.proxies.core}
        actions={
          canEdit ? (
            <Button disabled={checking} onClick={() => void check()}>
              {checking ? "Проверяем…" : "Проверить сейчас"}
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-5">
          <Section title="Запущено">
            <KeyValue
              items={[
                [
                  "Версия",
                  running.state === "ok" && running.version !== null ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono">{running.version}</span>
                      {runningCompat === null ? null : <Badge tone={runningCompat.tone}>{runningCompat.label}</Badge>}
                    </span>
                  ) : running.state === "unreadable" ? (
                    "Версия не распознана — проверьте контейнер Xray"
                  ) : (
                    <span className="flex flex-col gap-0.5">
                      <span>Ядро не сообщило версию</span>
                      <span className="text-xs text-text-muted">Контейнер Xray не запущен или собран до версии со статусом ядра. В dev контейнера нет</span>
                    </span>
                  ),
                ],
                ["Запущено", formatDateTime(running.startedAt)],
              ]}
            />
            {note === null ? null : <Notice tone={note.tone}>{note.text}</Notice>}
          </Section>

          <Section title="Свежий выпуск XTLS">
            {latest === null ? (
              view.latestError === null ? (
                <p className="text-sm text-text-muted">Выпуск ещё не проверялся</p>
              ) : (
                <Notice tone="warning">{view.latestError}</Notice>
              )
            ) : (
              <KeyValue
                items={[
                  [
                    "Версия",
                    <a key="version" href={latest.url} target="_blank" rel="noreferrer" className="font-mono text-accent hover:underline">
                      {latest.version}
                    </a>,
                  ],
                  ["Вышел", formatDateTime(latest.publishedAt)],
                  ["Проверено", formatDateTime(latest.checkedAt)],
                ]}
              />
            )}
          </Section>

          <Section title="Совместимость">
            {latestCompat === null ? (
              <p className="text-sm text-text-muted">Свежий выпуск не получен — сравнивать не с чем</p>
            ) : (
              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={latestCompat.tone}>{latestCompat.label}</Badge>
                  {latestCompat.detail === null || latestCompat.tone === "danger" ? null : <span className="text-text-muted">{latestCompat.detail}</span>}
                </div>
                {latestCompat.tone === "danger" && latestCompat.detail !== null ? <p className="break-words text-text-muted">{latestCompat.detail}</p> : null}
              </div>
            )}
            <p className="text-xs text-text-muted">{testedRangeText(view.tested.min, view.tested.max)}</p>
          </Section>

          {canEdit ? (
            <Section title="Обновление">
              {!update.configured ? (
                <p className="text-sm text-text-muted">
                  Кнопка «Обновить» появится, когда в{" "}
                  <a href={hrefOf({ section: "secrets", id: null })} className="text-accent hover:underline">
                    «Ключах интеграций»
                  </a>{" "}
                  задан github.xray-update
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    tone="primary"
                    disabled={update.blockedBy !== null}
                    blockedBy={update.blockedBy === null ? null : blockedText(update.blockedBy, update.lockedUntil)}
                    onClick={() => setConfirming(true)}
                  >
                    {latest === null ? "Обновить" : `Обновить до ${latest.version}`}
                  </Button>
                </div>
              )}
            </Section>
          ) : null}

          {update.lastRun === null ? null : (
            <Section title="Последний запуск">
              <LastRun run={update.lastRun} />
              {update.lastRunError === null ? null : <p className="break-words text-xs text-text-muted">{update.lastRunError}</p>}
            </Section>
          )}
        </div>
      </Panel>
      {confirming && latest !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(false);
          }}
          title="Обновить ядро Xray"
          subject={`${running.version ?? "?"} → ${latest.version}`}
          changes={[{ label: "Что будет", value: "PR в dev от workflow xray-bump.yml" }]}
          action="Запустить обновление"
          onConfirm={async () => {
            const result = await updateXrayCore(api, latest.version);
            if (!result.ok) return { ok: false, error: result.error.message };
            toast.success("Обновление запущено", { description: "PR появится через пару минут — ссылка в строке последнего запуска" });
            setFresh(result.data);
            return { ok: true };
          }}
        >
          <p className="text-sm text-text-muted">Workflow проверит наш конфиг на новом ядре и откроет PR. На прод ядро уедет после вливания — с выпуском</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function LastRun({ run }: { run: NonNullable<XrayCoreView["update"]["lastRun"]> }) {
  const text = runText(run);
  return (
    <p className="min-w-0 break-words text-sm">
      {run.title} — <span className={TEXT_TONES[text.tone]}>{text.label}</span>, {formatDateTime(run.createdAt)}{" "}
      <a href={run.url} target="_blank" rel="noreferrer" className="whitespace-nowrap text-accent hover:underline">
        Открыть в GitHub
      </a>
    </p>
  );
}
