import { fetchUnknownKeys, UNKNOWN_KEYS_HELP } from "../../api/links";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { DataTable, ErrorNotice, Loading, Panel } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

/**
 * Незнакомые метки (Р116): ключи параметра запуска, которых нет в списке. Только чтение — ключ добавляется
 * правкой списка в коде, а не из панели. Блок показывается на экране «Ссылки», а тот открыт только с правом
 * `links.manage`, поэтому отдельной проверки права нет.
 */
export function UnknownKeys() {
  const { state, reload } = useApi(() => fetchUnknownKeys(api), []);

  return (
    <Panel title="Незнакомые метки" help={UNKNOWN_KEYS_HELP}>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        // Таблица прокручивается внутри блока: на 320 px страница в ширину не растёт.
        <div className="max-w-full overflow-x-auto">
          <DataTable
            rows={state.data.keys}
            rowKey={(row) => row.key}
            empty="Незнакомых меток пока нет"
            columns={[
              { title: "Ключ", render: (row) => <code className="text-xs break-all">{row.key}</code> },
              { title: "Сколько раз", render: (row) => formatNumber(row.hits), align: "right" },
              { title: "Последний раз", render: (row) => <span className="whitespace-nowrap">{formatDateTime(row.lastAt)}</span> },
            ]}
          />
        </div>
      ) : null}
    </Panel>
  );
}
