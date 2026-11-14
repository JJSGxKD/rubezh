import { formatLine, formatMoney, lineTone, type LineTone } from "../../../api/ledger";
import { KIND_LABELS, STATUS_LABELS, statusTone, type ArticleView, type OperationView } from "../../../api/ledger-operations";
import { formatDateTime } from "../../../format";
import { Badge, Button } from "../../../ui/kit";
import { previewOf, RECEIPT_WARNING, type ChartPlace, type PreviewLine } from "./preview";
import { amountText, dayText } from "./summary";

/**
 * Карточка операции в списке (tasks/T-0464): статус-метка, вид, сумма в валюте и ≈ $, кто и когда, причина, строки
 * проводки. Кнопки — по статусу и праву: решение владельца — `finance.operation.approve`, остальное — `finance.entry.create`.
 * Проведённая операция не правится: «Исправить» заводит сторно (Р220).
 */
const TONES: Record<LineTone, string> = { debit: "text-success", credit: "text-danger", zero: "text-text-muted" };

export interface OperationCardProps {
  operation: OperationView;
  places: readonly ChartPlace[];
  articles: readonly ArticleView[];
  /** есть право `finance.operation.approve` */
  canApprove: boolean;
  /** есть право `finance.entry.create` */
  canEdit: boolean;
  /** идёт запрос по этой операции */
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onSubmit: () => void;
  onEdit: () => void;
  onDiscard: () => void;
  onFix: () => void;
}

export function Lines({ lines }: { lines: readonly PreviewLine[] }) {
  return (
    <ul className="flex flex-col gap-0.5 text-sm tabular-nums">
      {lines.map((line) => (
        <li key={`${line.accountName}|${line.amount}`} className="flex flex-wrap justify-between gap-x-3">
          <span className="min-w-0">{line.accountName}</span>
          <span className={`font-medium ${TONES[lineTone(line.amount)]}`}>{formatLine(line.amount, line.currency)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Строки проводки: у проведённой — настоящие, из журнала; у остальных — предпросмотр по справочнику. */
function linesOf(operation: OperationView, places: readonly ChartPlace[], articles: readonly ArticleView[]): readonly PreviewLine[] {
  if (operation.entry !== null) return operation.entry.lines;
  if (operation.status === "rejected" || operation.input.kind === "reversal") return [];
  const preview = previewOf(operation.input, { places, articles });
  return preview.ok ? preview.lines : [];
}

export function OperationCard(props: OperationCardProps) {
  const { operation, busy } = props;
  const { input } = operation;
  const lines = linesOf(operation, props.places, props.articles);
  const canDecide = props.canApprove && operation.status === "pending";
  const isDraft = operation.status === "draft";
  const canFix = props.canEdit && operation.status === "posted" && operation.entry !== null && input.kind !== "reversal";

  return (
    <li className="flex flex-col gap-2 rounded-sm border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={statusTone(operation.status)}>{STATUS_LABELS[operation.status]}</Badge>
        <span className="font-medium">{KIND_LABELS[operation.kind]}</span>
        <span className="min-w-24 flex-1 text-right font-medium tabular-nums">
          {amountText(operation, props.places)}
          {operation.amountUsd === null ? null : <span className="ml-2 text-xs font-normal text-text-muted">{`≈ ${formatMoney(operation.amountUsd)} $`}</span>}
        </span>
      </div>
      <p className="text-sm">{input.note}</p>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <span>{`${dayText(input.at)} · ${operation.createdBy} · внесена ${formatDateTime(operation.createdAt)}`}</span>
        {operation.templatePeriod === null ? null : <Badge>{`Шаблон · ${operation.templatePeriod}`}</Badge>}
        {operation.receiptMissing ? <Badge tone="warning">{RECEIPT_WARNING.split(":")[0] ?? RECEIPT_WARNING}</Badge> : null}
        {input.link === undefined ? null : (
          <a className="break-all underline hover:text-accent" href={input.link} target="_blank" rel="noreferrer noopener">
            ссылка
          </a>
        )}
      </p>
      {input.kind === "reversal" ? <p className="font-mono text-xs text-text-muted">{`исправляет ${input.sourceKey ?? ""}`}</p> : null}
      {operation.status === "rejected" && operation.decisionNote !== null ? <p className="text-sm text-danger">{`Отклонил(а) ${operation.decidedBy ?? "владелец"}: ${operation.decisionNote}`}</p> : null}
      {operation.status === "posted" && operation.decidedBy !== null ? (
        <p className="text-xs text-text-muted">{`Подтвердил(а) ${operation.decidedBy}${operation.decisionNote === null ? "" : `: ${operation.decisionNote}`}`}</p>
      ) : null}
      {lines.length === 0 ? null : <Lines lines={lines} />}
      {canDecide || (props.canEdit && (isDraft || canFix)) ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {canDecide ? (
            <>
              <Button tone="primary" disabled={busy} onClick={props.onApprove}>
                Подтвердить
              </Button>
              <Button tone="danger" disabled={busy} onClick={props.onReject}>
                Отклонить
              </Button>
            </>
          ) : null}
          {props.canEdit && isDraft ? (
            <>
              <Button tone="primary" disabled={busy} onClick={props.onSubmit}>
                Провести
              </Button>
              <Button disabled={busy} onClick={props.onEdit}>
                Править
              </Button>
              <Button tone="danger" disabled={busy} onClick={props.onDiscard}>
                Удалить
              </Button>
            </>
          ) : null}
          {canFix ? (
            <Button disabled={busy} onClick={props.onFix}>
              Исправить
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
