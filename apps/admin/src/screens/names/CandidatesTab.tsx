import { useState } from "react";
import {
  acceptCandidate,
  candidatesNote,
  defaultKind,
  dismissCandidate,
  firstSeenText,
  kindTitle,
  type AcceptKind,
  type Candidate,
  type CandidatesView,
} from "../../api/name-rule-candidates";
import { CATEGORY_ACTIONS, CATEGORY_TITLES, type RuleCategory, type RuleLimits } from "../../api/name-rules";
import { formatNumber } from "../../format";
import { api } from "../../services";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, Field, Help, Notice, Select } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { TryOutDialog } from "./TryOutDialog";

/** Категории «в стирания»: бренды первыми — чаще всего слово из расчёта чужой бренд. Исключения — отдельной кнопкой. */
const ERASE_CATEGORIES = ["brand", "ads", "profanity", "other"] as const satisfies readonly RuleCategory[];
const ACCEPT_KINDS = ["word", "exact"] as const satisfies readonly AcceptKind[];

const RULE_ADDED = "Правило добавлено — действует у новых входов";

/**
 * Вкладка «Кандидаты» (Р168, tasks/T-0341): слова и пары слов из ночного
 * расчёта. «В стирания» открывает выбор категории и вида, «В исключения» и
 * «Не нужно» — подтверждение. Из панели видны только слово и число игроков:
 * ников и аккаунтов сервер не хранит.
 */
export function CandidatesTab({ view, limits, onChanged }: { view: CandidatesView; limits: RuleLimits; onChanged: () => void }) {
  const [erasing, setErasing] = useState<Candidate | null>(null);
  const [allowing, setAllowing] = useState<Candidate | null>(null);
  const [dismissing, setDismissing] = useState<Candidate | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-start gap-1.5 text-xs text-text-muted">
        <span>{candidatesNote(view)}</span>
        <Help text={HELP.names.candidates} />
      </p>
      <p className="flex items-start gap-1.5 text-xs text-text-muted">
        <span>В базе и в журнале — только слово и число игроков.</span>
        <Help text={HELP.names.candidatesPrivacy} />
      </p>
      <DataTable
        rows={view.items}
        rowKey={(candidate) => candidate.candidateId}
        empty={view.computedAt === null ? "Расчёт ещё не запускался" : "Кандидатов нет"}
        columns={[
          { title: "Слово или пара", render: (candidate) => <code className="font-mono text-sm break-words">{candidate.token}</code> },
          { title: "Тип", render: (candidate) => <Badge tone="neutral">{kindTitle(candidate.kind)}</Badge> },
          { title: "Игроков", align: "right", render: (candidate) => formatNumber(candidate.players) },
          { title: "Впервые замечено", render: (candidate) => <span className="md:whitespace-nowrap">{firstSeenText(candidate.firstSeenAt)}</span> },
          {
            title: "",
            render: (candidate) => (
              <span className="flex flex-wrap justify-end gap-1.5 max-md:flex-col max-md:items-stretch">
                <Button tone="primary" onClick={() => setErasing(candidate)}>
                  В стирания
                </Button>
                <Button onClick={() => setAllowing(candidate)}>В исключения</Button>
                <Button onClick={() => setDismissing(candidate)}>Не нужно</Button>
              </span>
            ),
          },
        ]}
      />

      {erasing === null ? null : (
        <EraseDialog
          candidate={erasing}
          limits={limits}
          onClose={() => setErasing(null)}
          onAdded={() => {
            setErasing(null);
            toast.success(RULE_ADDED);
            onChanged();
          }}
        />
      )}
      <ConfirmDialog
        open={allowing !== null}
        onOpenChange={(open) => {
          if (!open) setAllowing(null);
        }}
        title="В исключения?"
        subject={allowing?.token ?? ""}
        action="Добавить в исключения"
        onConfirm={async () => {
          if (allowing === null) return { ok: true };
          const result = await acceptCandidate(api, allowing.candidateId, { category: "allow", kind: defaultKind(allowing) });
          if (!result.ok) return { ok: false, error: result.error.message };
          toast.success(RULE_ADDED);
          onChanged();
          return { ok: true };
        }}
      >
        <p className="text-sm">Добавить «{allowing?.token ?? ""}» в исключения? Оно перестанет вырезаться правилами и встроенным словарём.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dismissing !== null}
        onOpenChange={(open) => {
          if (!open) setDismissing(null);
        }}
        title="Скрыть кандидата?"
        subject={dismissing?.token ?? ""}
        action="Скрыть"
        onConfirm={async () => {
          if (dismissing === null) return { ok: true };
          const result = await dismissCandidate(api, dismissing.candidateId);
          if (!result.ok) return { ok: false, error: result.error.message };
          toast.success("Скрыто");
          onChanged();
          return { ok: true };
        }}
      >
        <p className="text-sm">
          Скрыть «{dismissing?.token ?? ""}»? Оно не появится снова, пока его встречают у {formatNumber(view.minPlayers)} и более игроков.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/** «В стирания»: категория и вид правила, проверка на примерах до добавления. */
function EraseDialog({ candidate, limits, onClose, onAdded }: { candidate: Candidate; limits: RuleLimits; onClose: () => void; onAdded: () => void }) {
  const [category, setCategory] = useState<RuleCategory>("brand");
  const [kind, setKind] = useState<AcceptKind>(defaultKind(candidate));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);

  const submit = async (): Promise<void> => {
    setPending(true);
    setFailure(null);
    const result = await acceptCandidate(api, candidate.candidateId, { category, kind });
    setPending(false);
    if (!result.ok) {
      // Дубль и остальные отказы — текстом сервера, строка остаётся.
      setFailure(result.error.message);
      return;
    }
    onAdded();
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="В стирания"
        description={`«${candidate.token}»: ${kindTitle(candidate.kind).toLowerCase()}, ${formatNumber(candidate.players)} игроков. Правило начинает действовать у новых входов в течение секунд.`}
        footer={
          <>
            <Button onClick={onClose}>Отмена</Button>
            <Button tone="primary" disabled={pending} onClick={() => void submit()}>
              {pending ? "Добавляем…" : "Добавить правило"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Категория" help={HELP.names.categories}>
            <Select value={category} onChange={(event) => setCategory(ERASE_CATEGORIES.find((item) => item === event.target.value) ?? "brand")}>
              {ERASE_CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {CATEGORY_TITLES[item]} — {CATEGORY_ACTIONS[item]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Как искать" help={HELP.names.kinds}>
            <Select value={kind} onChange={(event) => setKind(ACCEPT_KINDS.find((item) => item === event.target.value) ?? defaultKind(candidate))}>
              {ACCEPT_KINDS.map((item) => (
                <option key={item} value={item}>
                  {item === "word" ? "Слово целиком" : "Точная фраза"}
                </option>
              ))}
            </Select>
          </Field>
          <button type="button" className="self-start text-sm text-accent underline-offset-2 hover:underline" onClick={() => setTrying(true)}>
            Проверить на примерах
          </button>
          {failure === null ? null : <Notice>{failure}</Notice>}
        </div>
      </Dialog>
      {trying ? <TryOutDialog limits={limits} candidate={{ category, kind, pattern: candidate.token }} onClose={() => setTrying(false)} /> : null}
    </>
  );
}
