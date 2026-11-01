import { useState, type ReactNode } from "react";
import { Gift } from "lucide-react";
import { Button, Card, SectionTitle } from "../../design-system/components";
import { formatDuration, formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/season";
import { claimPending, createSeasonsApi, type PendingReward, type SeasonData, type SeasonHistoryItem, type SeasonReward } from "../../state/seasons-api";
import { loadWallet } from "../../state/wallet-api";
import { ladderRows, pendingTotal, seasonRangeLabel, thresholdProgress } from "./rating-rules";

/**
 * Награды сезона (tasks/T-0111): плашка «Забрать» за прошлые сезоны, карточка
 * «Награды недели» и свёрнутый список прошлых сезонов. Престиж — числом без
 * значка кошелька: хранилища престижа пока нет (T-0110).
 */
const api = createSeasonsApi();

/** Рейтинговая сложность одна (Р126): пороги и множитель берутся для неё. */
const DIFFICULTY = "hard";

/** Разворот списка прошлых сезонов запоминается удобством одного зрителя. */
const HISTORY_OPEN_KEY = "bh.rating.history.open";

function sumText(reward: SeasonReward): string {
  return t("season.claim.sum", { coins: formatNumber(reward.coins), prestige: formatNumber(reward.prestige) });
}

type Notice = { kind: "done" | "error"; text: string };

/**
 * Плашка над вкладками: что ждёт за прошлый сезон. Забирает записи подряд,
 * кнопка крутится и второго нажатия не принимает; после успеха плашка
 * исчезает, а на её месте остаётся сообщение о начисленном.
 */
export function ClaimArea(props: { pending: readonly PendingReward[]; reload(): Promise<void> }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const claim = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const result = await claimPending(api, props.pending);
    await props.reload();
    void loadWallet();
    setBusy(false);
    if (result.failed) setNotice({ kind: "error", text: t("season.claim.error") });
    else if (result.credited.coins > 0 || result.credited.prestige > 0) {
      setNotice({ kind: "done", text: t("season.claim.done", { coins: formatNumber(result.credited.coins), prestige: formatNumber(result.credited.prestige) }) });
    }
  };

  const noticeView =
    notice === null ? null : (
      <p role="status" className={`text-sm ${notice.kind === "error" ? "text-danger" : "text-text"}`}>
        {notice.text}
      </p>
    );
  if (props.pending.length === 0) return noticeView === null ? null : <div className="mb-3">{noticeView}</div>;

  return (
    <div className="surface-card-selected mb-3 flex flex-wrap items-center gap-3 rounded-lg p-3">
      <Gift size={20} aria-hidden="true" className="shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="font-display text-sm font-bold text-text">{t("season.claim.title")}</p>
        <p className="text-sm text-text-muted">{sumText(pendingTotal(props.pending))}</p>
        {noticeView}
      </div>
      <Button track="claim_season" loading={busy} onClick={() => void claim()}>
        {t("season.claim.button")}
      </Button>
    </div>
  );
}

/** Награды недели: порог с прогрессом, ступени мест и условие числа игроков. */
export function RewardsCard(props: { data: SeasonData; best: number | null; total: number | null }): ReactNode {
  const { data } = props;
  const threshold = data.thresholds[DIFFICULTY];
  const rows = ladderRows(data.placeLadder, data.difficultyMul[DIFFICULTY] ?? 1);
  const progress = threshold === undefined ? null : thresholdProgress(props.best, threshold);

  return (
    <Card>
      <SectionTitle as="h3" spacing="mb-2">
        {t("season.rewards.title")}
      </SectionTitle>
      {threshold === undefined || progress === null ? null : (
        <div className="mb-3">
          <p className="text-sm text-text">
            {t("season.rewards.threshold", {
              time: formatDuration(threshold),
              coins: formatNumber(data.thresholdReward.coins),
              prestige: formatNumber(data.thresholdReward.prestige),
            })}
          </p>
          <p className={`text-xs ${progress.reached ? "text-success" : "text-text-muted"}`}>
            {progress.reached ? t("season.rewards.threshold.reached") : t("season.rewards.threshold.left", { time: formatDuration(Math.ceil(progress.leftSec)) })}
          </p>
        </div>
      )}
      {rows.length === 0 ? null : (
        <ul className="grid gap-1">
          {rows.map((row) => (
            <li key={row.label} className="text-sm text-text">
              {t("season.rewards.place", { place: row.label, coins: formatNumber(row.coins), prestige: formatNumber(row.prestige) })}
            </li>
          ))}
        </ul>
      )}
      {data.minBoard > 0 ? (
        <p className="mt-3 text-xs text-text-muted">{t("season.rewards.minBoard", { min: data.minBoard, total: props.total ?? 0 })}</p>
      ) : null}
    </Card>
  );
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(HISTORY_OPEN_KEY) === "1";
  } catch {
    // Хранилище закрыто (приватный режим, чужой WebView) — список просто свёрнут.
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(HISTORY_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Не записалось — в следующий вход список снова свёрнут, игроку это не мешает.
  }
}

function difficultyName(id: string): string {
  const key = `difficulty.${id}.name`;
  return hasTranslation(key) ? t(key) : id;
}

function HistoryRow({ item }: { item: SeasonHistoryItem }): ReactNode {
  return (
    <li className="surface-sunken rounded-lg p-3">
      <p className="font-display text-sm font-bold text-text">{seasonRangeLabel(item.startsAt, item.endsAt)}</p>
      {item.results.map((result) => (
        <p key={result.difficulty} className="text-sm text-text-muted">
          {t("season.history.row", {
            difficulty: difficultyName(result.difficulty),
            time: formatDuration(result.bestSec),
            place: result.place,
            total: result.boardSize,
          })}
        </p>
      ))}
      {item.reward === null ? null : (
        <p className="mt-1 text-xs text-text-muted">
          {`${item.reward.claimed ? t("season.history.reward.claimed") : t("season.history.reward.pending")} · ${sumText(item.reward)}`}
        </p>
      )}
    </li>
  );
}

/** Прошлые сезоны — свёрнутым списком; разворот помнит `localStorage`. */
export function HistoryList(props: { history: readonly SeasonHistoryItem[] }): ReactNode {
  const [open, setOpen] = useState(readOpen);
  if (props.history.length === 0) return null;

  return (
    <details
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        writeOpen(next);
      }}
    >
      <summary className="cursor-pointer font-display text-xs font-semibold tracking-widest text-text-muted uppercase">
        {t("season.history.title")}
      </summary>
      <ul className="mt-2 grid gap-2">
        {props.history.map((item) => (
          <HistoryRow key={item.seasonKey} item={item} />
        ))}
      </ul>
    </details>
  );
}
