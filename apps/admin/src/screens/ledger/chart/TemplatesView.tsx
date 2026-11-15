import { scheduleLabel, type Template } from "../../../api/ledger-chart";
import { formatAmount } from "../../../api/ledger";
import { Button, Panel } from "../../../ui/kit";

/**
 * Шаблоны повторяющихся расходов: название, статья, место, сумма, график. «Расходы месяца» создаёт по ним
 * черновики операций — проводит их человек.
 */
export function TemplatesView({
  templates,
  canEdit,
  notes,
  onAdd,
  onEdit,
  onArchive,
}: {
  templates: readonly Template[];
  canEdit: boolean;
  notes: Readonly<Record<string, string>>;
  onAdd: () => void;
  onEdit: (template: Template) => void;
  onArchive: (template: Template) => void;
}) {
  const live = templates.filter((template) => !template.archived);
  return (
    <Panel title="Шаблоны расходов" help="Повторяющиеся расходы с графиком: сервер, CDN, подписки. По ним создаются черновики операций" actions={canEdit ? <Button onClick={onAdd}>Добавить шаблон</Button> : undefined}>
      {live.length === 0 ? (
        <p className="text-sm text-text-muted">Шаблонов пока нет. Заведите сервер, CDN и ИИ-инструменты — каждый месяц они будут появляться черновиками</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {live.map((template) => (
            <li key={template.templateId} className="flex flex-col gap-1 border-b border-border pb-3 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <b className="text-sm">{template.name}</b>
                <span className="text-sm font-semibold tabular-nums">{formatAmount(template.amount, template.currency)}</span>
              </div>
              <p className="text-xs text-text-muted">
                {template.articleName} · с места «{template.placeName}» · {scheduleLabel(template.schedule, template.month)}
              </p>
              {template.note === null ? null : <p className="text-xs text-text-muted">{template.note}</p>}
              {canEdit ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button onClick={() => onEdit(template)}>Изменить</Button>
                  <Button onClick={() => onArchive(template)}>В архив</Button>
                </div>
              ) : null}
              {notes[template.templateId] === undefined ? null : (
                <p role="alert" className="text-xs text-danger">
                  {notes[template.templateId]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
