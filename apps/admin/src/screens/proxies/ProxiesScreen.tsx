import { useState } from "react";
import { checkProxy, fetchProxies, type ProxyRow } from "../../api/proxies";
import { api } from "../../services";
import { useSession } from "../../state/use-session";
import { HELP } from "../../ui/help";
import { Button, ErrorNotice, Loading, Notice, Panel } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { ModesPanel } from "./ModesPanel";
import { ProxyCard } from "./ProxyCard";
import { ProxyDialog } from "./ProxyDialog";

/**
 * Прокси для исходящих запросов (docs/35-stage4-plan.md Р91, tasks/T-0065):
 * через что сервер ходит к внешним API, если напрямую не достучаться, и режим
 * каждого сервиса. Пароль не показывается никогда — только «задан»; менять и
 * проверять прокси может владелец, администратор список видит.
 */
export function ProxiesScreen() {
  const { state, reload } = useApi(() => fetchProxies(api), []);
  const canEdit = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("proxies.edit"));
  const [editing, setEditing] = useState<ProxyRow | "new" | null>(null);
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());

  const check = async (row: ProxyRow) => {
    setChecking((current) => new Set(current).add(row.proxyId));
    const result = await checkProxy(api, row.proxyId);
    setChecking((current) => {
      const next = new Set(current);
      next.delete(row.proxyId);
      return next;
    });
    if (!result.ok) return void toast.error(result.error.message);
    if (result.data.ok) toast.success(`«${row.name}» работает`, { description: result.data.message });
    else toast.error(`«${row.name}» не отвечает`, { description: result.data.message });
    reload();
  };

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const { enabled, proxies } = state.data;

  return (
    <div className="flex flex-col gap-4">
      {enabled ? null : (
        <Notice tone="info">
          Пароль прокси хранится зашифрованным, а ключа шифрования на сервере нет: прокси с паролем сохранить нельзя. Задайте{" "}
          <code className="font-mono">SECRETS_ENCRYPTION_KEY</code> в .env сервера (<code className="font-mono">openssl rand -base64 32</code>) и перезапустите API. Прокси без пароля работают и сейчас.
        </Notice>
      )}
      <Panel
        title="Прокси"
        help={HELP.proxies.list}
        actions={
          <>
            <Button onClick={reload}>Обновить</Button>
            {canEdit ? (
              <Button tone="primary" onClick={() => setEditing("new")}>
                Добавить прокси
              </Button>
            ) : null}
          </>
        }
      >
        {proxies.length === 0 ? (
          <p className="text-sm text-text-muted">Прокси нет — сервер ходит ко всем внешним API напрямую</p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {proxies.map((row) => (
              <ProxyCard key={row.proxyId} row={row} editable={canEdit} checking={checking.has(row.proxyId)} onCheck={() => void check(row)} onEdit={() => setEditing(row)} />
            ))}
          </div>
        )}
      </Panel>
      <ModesPanel canEdit={canEdit} />
      {canEdit ? null : <p className="text-xs text-text-muted">Заводить, менять и проверять прокси может только владелец. Вам видно, какие прокси есть и как они ответили.</p>}
      {editing === null ? null : (
        <ProxyDialog
          existing={editing === "new" ? null : editing}
          storageEnabled={enabled}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            toast.success(created ? `Прокси «${saved.name}» добавлен` : `Прокси «${saved.name}» сохранён`, { description: "Клиент подхватит его в течение полуминуты — без перезапуска" });
            reload();
          }}
        />
      )}
    </div>
  );
}
