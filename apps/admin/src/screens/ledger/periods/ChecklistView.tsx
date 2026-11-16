import type { ReactNode } from "react";
import type { ChecklistItem } from "../../../api/ledger-periods";
import { Notice } from "../../../ui/kit";

/**
 * Чек-лист сверки месяца (tasks/T-0470, docs/37-accounting.md §13): блокеры красным — закрыть нельзя, пока они есть;
 * предупреждения жёлтым — закрыть можно, они останутся в снимке. Каждая ссылка ведёт к тому, что чинить: операции,
 * проводки, оплаты, курсы. Тексты и числа — как их посчитал сервер.
 */

const REF_LABELS = { operation: "операция", purchase: "оплата", entry: "проводка", rate: "курс" } as const;

/** Куда вести по ссылке: у каждого вида — свой раздел панели. */
const REF_HREFS = { operation: "#/ledger/operations", purchase: "#/payments", entry: "#/ledger/journal", rate: "#/fx" } as const;

/** Длинный идентификатор — первыми знаками; «валюта:день» у курса короткий и показывается целиком. */
function shortId(kind: keyof typeof REF_LABELS, id: string): string {
  return kind === "rate" ? id : id.slice(0, 8);
}

function Item({ item, tone }: { item: ChecklistItem; tone: "danger" | "warning" }): ReactNode {
  return (
    <li className="flex flex-col gap-1">
      <Notice tone={tone}>{item.message}</Notice>
      {item.refs.length === 0 ? null : (
        <p className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-xs text-text-muted">
          {item.refs.map((ref) => (
            <a key={`${ref.kind}:${ref.id}`} href={REF_HREFS[ref.kind]} className="underline hover:text-text">
              {`${REF_LABELS[ref.kind]} ${shortId(ref.kind, ref.id)}`}
            </a>
          ))}
          {item.moreRefs > 0 ? <span>{`и ещё ${String(item.moreRefs)}`}</span> : null}
        </p>
      )}
    </li>
  );
}

export function ChecklistView({ items }: { items: readonly ChecklistItem[] }): ReactNode {
  const blockers = items.filter((item) => item.severity === "blocker");
  const warnings = items.filter((item) => item.severity === "warning");
  return (
    <div className="flex flex-col gap-3">
      {blockers.length === 0 ? (
        <p className="text-sm text-success">Блокеров нет</p>
      ) : (
        <section aria-label="Блокеры" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-danger">Мешает закрыть</h3>
          <ul className="flex flex-col gap-2">
            {blockers.map((item) => (
              <Item key={item.code} item={item} tone="danger" />
            ))}
          </ul>
        </section>
      )}
      {warnings.length === 0 ? null : (
        <section aria-label="Предупреждения" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-warning">Предупреждения</h3>
          <ul className="flex flex-col gap-2">
            {warnings.map((item) => (
              <Item key={item.code} item={item} tone="warning" />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
