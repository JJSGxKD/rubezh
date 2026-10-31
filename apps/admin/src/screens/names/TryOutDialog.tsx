import { useState } from "react";
import { probeRule, verdictText, type ProbeBody, type ProbeResult, type RuleLimits } from "../../api/name-rules";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, Field, Notice, TextArea } from "../../ui/kit";

/**
 * «Проверить на примерах»: ники по одному на строке, итог по всем действующим
 * правилам вместе с кандидатом из формы. Правило не сохраняется.
 */
export function TryOutDialog({ limits, candidate, onClose }: { limits: RuleLimits; candidate: Omit<ProbeBody, "samples">; onClose: () => void }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<ProbeResult[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const samples = text.split("\n").filter((line) => line.trim() !== "");
  const tooMany = samples.length > limits.samplesMax;

  const run = async (): Promise<void> => {
    setPending(true);
    setError(null);
    const result = await probeRule(api, { ...candidate, samples });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setResults(result.data);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Проверить на примерах"
      description="Правило не сохраняется: ники проверяются по всем действующим правилам вместе с ним."
      footer={
        <>
          <span className={`mr-auto text-xs tabular-nums ${tooMany ? "text-danger" : "text-text-muted"}`}>
            {samples.length} из {limits.samplesMax}
          </span>
          <Button onClick={onClose}>Закрыть</Button>
          <Button tone="primary" disabled={pending || samples.length === 0 || tooMany} onClick={() => void run()}>
            {pending ? "Проверяем…" : "Проверить"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="По одному нику на строке" help={HELP.names.probe}>
          <TextArea rows={6} value={text} onChange={(event) => setText(event.target.value)} placeholder="Вася пример-бренд" />
        </Field>
        {error === null ? null : <Notice>{error}</Notice>}
        {results === null ? (
          <p className="text-sm text-text-muted">Вставьте несколько ников — покажем, что с ними сделает правило вместе с остальными</p>
        ) : (
          <DataTable
            rows={results}
            rowKey={(result) => result.sample}
            columns={[
              { title: "Ник", render: (result) => <code className="font-mono text-sm break-all">{result.sample}</code> },
              { title: "Что станет", render: (result) => verdictText(result) },
              {
                title: "Правило",
                render: (result) => (result.saved ? <Badge tone="info">спасло исключение</Badge> : result.candidateHit ? <Badge tone="warning">правило сработало</Badge> : <span className="text-text-muted">не задело</span>),
              },
            ]}
          />
        )}
      </div>
    </Dialog>
  );
}
