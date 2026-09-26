import { useState, type FormEvent } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import { broadcastProblem, estimateAudience, segmentProblem, type BroadcastInput } from "../../api/broadcasts";
import { formatNumber } from "../../format";
import { Button, Field, Input, Notice, TextArea } from "../../ui/kit";
import { SegmentFields } from "./SegmentFields";

/**
 * Черновик рассылки: текст, кнопка и аудитория. Оценка аудитории — тем же
 * условием, что наберёт получателей на старте. Кнопку можно добавить только
 * при создании: под неё заводится ссылка кампании.
 */
export function BroadcastForm({
  initial,
  submitLabel,
  buttonLocked,
  onSubmit,
  onCancel,
}: {
  initial: BroadcastInput;
  submitLabel: string;
  /** правка: кнопку не добавить и не убрать — ссылка кампании уже заведена или её нет */
  buttonLocked: boolean;
  onSubmit: (input: BroadcastInput) => Promise<ApiError | null>;
  onCancel?: () => void;
}) {
  const [input, setInput] = useState<BroadcastInput>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [estimate, setEstimate] = useState<{ audience: number } | { error: ApiError } | null>(null);

  const problem = broadcastProblem(input);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    setPending(true);
    setError(await onSubmit(input));
    setPending(false);
  };

  const estimateNow = async () => {
    const result = await estimateAudience(api, input.segment);
    setEstimate(result.ok ? result.data : { error: result.error });
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <Field label="Название" hint="видно только в панели">
        <Input value={input.title} maxLength={120} onChange={(event) => setInput({ ...input, title: event.target.value })} className="w-96" />
      </Field>
      <Field label="Текст" hint={`простой текст, без разметки; ${input.text.length} из 4096`}>
        <TextArea value={input.text} maxLength={4096} rows={6} onChange={(event) => setInput({ ...input, text: event.target.value })} />
      </Field>
      <Field label="Кнопка" hint={buttonLocked ? "кнопку задают при создании" : "пусто — без кнопки; ведёт в игру через ссылку кампании рассылки"}>
        <Input value={input.buttonText} maxLength={64} disabled={buttonLocked} placeholder="Играть" onChange={(event) => setInput({ ...input, buttonText: event.target.value })} className="w-60" />
      </Field>
      <SegmentFields
        value={input.segment}
        onChange={(segment) => {
          setInput({ ...input, segment });
          setEstimate(null);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button tone="primary" type="submit" disabled={problem !== null || pending}>
          {submitLabel}
        </Button>
        <Button onClick={() => void estimateNow()} disabled={segmentProblem(input.segment) !== null}>
          Оценить аудиторию
        </Button>
        {onCancel === undefined ? null : <Button onClick={onCancel}>Отмена</Button>}
        {estimate === null ? null : "audience" in estimate ? (
          <span className="text-sm">Получат сейчас: {formatNumber(estimate.audience)}</span>
        ) : (
          <span className="text-sm text-danger">{estimate.error.message}</span>
        )}
      </div>
      {problem !== null && input.text !== "" ? <Notice tone="info">{problem}</Notice> : null}
      {error === null ? null : <Notice>{error.message}</Notice>}
    </form>
  );
}
