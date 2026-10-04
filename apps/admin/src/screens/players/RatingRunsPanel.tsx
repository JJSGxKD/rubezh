import { useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import { COMMENT_MAX } from "../../api/restrictions";
import { DIFFICULTY_IDS, fetchRatingRuns, firstDifficulty, holderOf, rankingEffect, setRunRanked, type DifficultyId, type RatingRun } from "../../api/rating-runs";
import { difficultyTitle } from "../../api/review";
import { formatDateTime, formatDuration, formatNumber } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Field, Loading, Notice, Panel, TextArea } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";

/**
 * Рекорды игрока в рейтинге (docs/35-stage4-plan.md WP44, часть 3б): какие
 * забеги держат его в досках и какие сняты модератором. Сомнительный рекорд
 * снимают отсюда, с причиной; ограничение рейтинга — в «Ограничениях» выше,
 * оно про срок, а это — про конкретный забег.
 */
export function RatingRunsPanel({ accountId, ratingClosed, onChanged }: { accountId: string; ratingClosed: boolean; onChanged: () => void }) {
  const { state, reload } = useApi(() => fetchRatingRuns(api, accountId), [accountId]);
  const view = useSession((session) => session.view);
  const canModerate = can(view, "players.restrict");
  const [picked, setPicked] = useState<DifficultyId | null>(null);
  const [acting, setActing] = useState<RatingRun | null>(null);

  const runs = state.status === "ok" ? state.data : null;
  const difficulty = picked ?? (runs === null ? "normal" : firstDifficulty(runs));
  const rows = runs?.[difficulty] ?? [];
  const holder = holderOf(rows);

  const changed = () => {
    reload();
    onChanged();
  };

  return (
    <Panel title="Рекорды в рейтинге" help={HELP.players.ratingRuns}>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {runs === null ? null : (
        <div className="flex flex-col gap-3">
          {ratingClosed ? <Notice tone="info">Рейтинг игроку закрыт ограничением — в досках его нет. Снятый здесь забег не вернётся вместе с ним по сроку.</Notice> : null}
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Сложность">
            {DIFFICULTY_IDS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={difficulty === id}
                onClick={() => setPicked(id)}
                className={`rounded-pill border px-3 py-1 text-xs transition-colors ${difficulty === id ? "border-accent bg-accent/15 text-accent" : "border-border text-text-muted hover:border-border-strong hover:text-text"}`}
              >
                {capitalize(difficultyTitle(id))} <span className="opacity-70">{runs[id].length}</span>
              </button>
            ))}
          </div>
          <DataTable
            rows={rows}
            rowKey={(run) => run.runId}
            empty="На этой сложности забегов в рейтинге нет"
            columns={[
              { title: "Рейтинг", render: (run) => <RunState run={run} holder={holder} ratingClosed={ratingClosed} /> },
              { title: "Время", render: (run) => formatDuration(run.survivalSec), align: "right" },
              { title: "Уровень", render: (run) => run.level, align: "right" },
              { title: "Убийств", render: (run) => formatNumber(run.enemiesKilled), align: "right" },
              { title: "Оружие", render: (run) => run.startingWeaponId },
              { title: "Когда", render: (run) => <span className="whitespace-nowrap">{formatDateTime(run.finishedAt)}</span> },
              ...(canModerate
                ? [
                    {
                      title: "",
                      align: "right" as const,
                      render: (run: RatingRun) => (
                        <Button className="whitespace-nowrap" onClick={() => setActing(run)}>
                          {run.ranked ? "Не учитывать…" : "Вернуть…"}
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      )}
      <RankDialog run={acting} rows={rows} difficulty={difficulty} ratingClosed={ratingClosed} onClose={() => setActing(null)} onDone={changed} />
    </Panel>
  );
}

function RunState({ run, holder, ratingClosed }: { run: RatingRun; holder: RatingRun | null; ratingClosed: boolean }) {
  if (!run.ranked) {
    return (
      <span className="whitespace-nowrap">
        <Badge tone="warning">не учитывается</Badge>
      </span>
    );
  }
  // При закрытом рейтинге рекорд не в доске — с ним игрок в неё вернётся по сроку.
  if (run.runId === holder?.runId) {
    return (
      <span className="whitespace-nowrap" title={ratingClosed ? "Сейчас игрока в досках нет — по сроку он вернётся с этим забегом" : "Этот забег держит игрока в доске"}>
        <Badge tone={ratingClosed ? "neutral" : "success"}>рекорд</Badge>
      </span>
    );
  }
  return <span className="text-xs text-text-muted">учтён</span>;
}

/** Не учитывать или вернуть — с причиной: она остаётся в журнале аудита, игрок её не видит. */
function RankDialog({
  run,
  rows,
  difficulty,
  ratingClosed,
  onClose,
  onDone,
}: {
  run: RatingRun | null;
  rows: readonly RatingRun[];
  difficulty: DifficultyId;
  ratingClosed: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const close = () => {
    setComment("");
    setError(null);
    onClose();
  };

  const unrank = run?.ranked ?? true;
  const effect = run === null ? "" : rankingEffect(rows, run, ratingClosed);

  const submit = async () => {
    if (run === null) return;
    setPending(true);
    setError(null);
    const result = await setRunRanked(api, run.runId, !unrank, comment.trim());
    setPending(false);
    if (!result.ok) {
      // Забег мог поменять другой модератор — список обновим, чтобы было видно, что с ним сейчас.
      if (result.error.status === 409) onDone();
      return setError(result.error);
    }
    toast.success(unrank ? "Забег больше не учитывается в рейтинге" : "Забег снова в рейтинге", { description: effect });
    close();
    onDone();
  };

  return (
    <Dialog
      open={run !== null}
      onOpenChange={(open) => (open ? undefined : close())}
      title={unrank ? "Не учитывать забег в рейтинге" : "Вернуть забег в рейтинг"}
      description={run === null ? "" : `${capitalize(difficultyTitle(difficulty))} · ${formatDuration(run.survivalSec)} · уровень ${String(run.level)} · ${formatDateTime(run.finishedAt)}`}
      footer={
        <>
          <Button onClick={close}>Отмена</Button>
          <Button tone={unrank ? "danger" : "primary"} disabled={comment.trim() === "" || pending} onClick={() => void submit()}>
            {pending ? "Сохраняем…" : unrank ? "Не учитывать" : "Вернуть в рейтинг"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm">{effect}</p>
        <p className="text-xs text-text-muted">
          {unrank
            ? "Игрок увидит у забега «Вне рейтинга» — без уведомления и без причины. Награда за забег остаётся, новые забеги идут в рейтинг как обычно; вернуть можно в любой момент."
            : "У забега снова будет «В рейтинге»."}
        </p>
        <Field label={unrank ? "Почему не учитывать" : "Почему возвращаете"} hint="Останется в журнале аудита. Игрок её не увидит.">
          <TextArea
            rows={3}
            maxLength={COMMENT_MAX}
            value={comment}
            placeholder={unrank ? "Например: 9 минут без урона — запись похожа на ускорение" : "Например: проверили запись — забег честный"}
            onChange={(event) => setComment(event.target.value)}
          />
        </Field>
        {error === null ? null : <Notice>{error.message}</Notice>}
      </div>
    </Dialog>
  );
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
