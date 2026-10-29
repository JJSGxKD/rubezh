import { checkSummary, proxyAddress, type ProxyRow } from "../../api/proxies";
import { formatDateTime } from "../../format";
import { HELP } from "../../ui/help";
import { Badge, Button, Help } from "../../ui/kit";

/**
 * Карточка прокси: название и состояние, адрес, страна и порядок, итог
 * последней проверки. Не строка таблицы: действия у карточки переносятся
 * под текст на узком экране, а в таблице-карточке телефона они налезали на
 * адрес.
 */
export function ProxyCard({ row, editable, checking, onCheck, onEdit }: { row: ProxyRow; editable: boolean; checking: boolean; onCheck: () => void; onEdit: () => void }) {
  const look = checkSummary(row);
  return (
    <article className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 max-w-2xl flex-1 basis-64 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{row.name}</span>
          <Badge tone={look.tone}>{look.label}</Badge>
          {row.enabled ? null : <Badge>Выключен</Badge>}
        </div>
        <code className="font-mono text-xs break-all">{proxyAddress(row)}</code>
        <p className="text-xs text-text-muted">
          {row.username === null ? "Без логина" : `${row.username}${row.passwordSet ? " · пароль задан" : ""}`} · {row.country} · порядок {row.priority}
        </p>
        <p className="text-xs text-text-muted">
          {look.detail}
          {row.lastCheck === null || row.passwordUnreadable ? "" : ` · ${formatDateTime(row.lastCheck.at)}`}
        </p>
        {row.note === null ? null : <p className="text-xs text-text-muted">{row.note}</p>}
      </div>
      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1">
            <Button onClick={onCheck} disabled={checking || row.passwordUnreadable}>
              {checking ? "Проверяю…" : "Проверить"}
            </Button>
            <Help text={HELP.proxies.check} />
          </span>
          <Button onClick={onEdit}>Изменить</Button>
        </div>
      ) : null}
    </article>
  );
}
