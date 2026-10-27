import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { api } from "../../services";
import type { PlayerCard } from "../../api/players";
import { BAN_KIND, fetchRestrictionCatalog, type Restriction } from "../../api/restrictions";
import { formatDateTime } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { Badge, Button } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";
import { useNarrow } from "../../ui/use-media";
import { shortId } from "./card-rules";
import { MessageDialog, WalletAdjustDialog } from "./PlayerActions";
import { RestrictDialog } from "./RestrictDialog";

type Dialog = "message" | "wallet" | "restrict" | "ban";

/** Скопировать в буфер: успех и отказ браузера — уведомлением, а не молчанием. */
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Скопировано");
  } catch {
    toast.error("Не удалось скопировать");
  }
}

/**
 * Шапка карточки (design/screens/admin-player.html): имя и метки, строка
 * данных и действия по правам. Окна действий открывает она; данные карточки
 * перечитывает `onChanged`. Без права на персональные данные ID на площадке
 * скрыт, без права на выручку «платящего» нет.
 */
export function PlayerHeader({ card, active, onChanged }: { card: PlayerCard; active: readonly Restriction[]; onChanged: () => void }) {
  const { account } = card;
  const view = useSession((session) => session.view);
  const narrow = useNarrow();
  const catalog = useApi(() => fetchRestrictionCatalog(api), []);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const canMessage = can(view, "players.message");
  const canWallet = can(view, "players.wallet.adjust");
  const canRestrict = can(view, "players.restrict");
  const canBan = can(view, "players.ban");
  // Блокированного снимают во вкладке «Ограничения», а не вторым «Заблокировать…».
  const canBanNow = canBan && account.banned === null;
  const paying = card.purchases !== null && (card.funnel?.firstPurchaseAt ?? null) !== null;
  const limited = active.filter((row) => row.kind !== BAN_KIND);

  const actions: { id: Dialog; title: string; tone?: "danger" }[] = [
    ...(canMessage ? [{ id: "message" as const, title: "Написать" }] : []),
    ...(canRestrict || canBan ? [{ id: "restrict" as const, title: "Ограничить…" }] : []),
    ...(canWallet ? [{ id: "wallet" as const, title: "Кошелёк ±" }] : []),
    ...(canBanNow ? [{ id: "ban" as const, title: "Заблокировать…", tone: "danger" as const }] : []),
  ];

  return (
    <header className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4 md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="inline-flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-raised font-display text-lg md:size-14 md:text-xl" aria-hidden="true">
          {account.photoUrl === null ? account.displayName.slice(0, 1).toUpperCase() : <img src={account.photoUrl} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />}
        </span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <h2 className="truncate font-display text-xl">{account.displayName}</h2>
            {paying ? <Badge tone="accent">платящий</Badge> : null}
            {limited.length === 0 ? null : <Badge tone="warning">закрыто: {limited.map((row) => (row.notify ? row.title : `${row.title} (молча)`)).join(", ")}</Badge>}
            {account.banned === null ? null : <Badge tone="danger">заблокирован {formatDateTime(account.banned.at)}</Badge>}
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
            {account.pii === null ? (
              <span>ID скрыт — нет права на персональные данные</span>
            ) : (
              <>
                <span className="inline-flex items-center gap-1">
                  ID {account.pii.platformUserId}
                  <CopyButton text={account.pii.platformUserId} />
                </span>
                <span>{account.pii.username === null ? "без юзернейма" : `@${account.pii.username}`}</span>
              </>
            )}
            <span>{account.platform}</span>
            <span>с нами с {formatDateTime(account.createdAt)}</span>
            <span className="inline-flex items-center gap-1" title={account.accountId}>
              аккаунт <code>{shortId(account.accountId)}</code>
              <CopyButton text={account.accountId} />
            </span>
          </p>
        </div>
      </div>

      {actions.length === 0 ? null : narrow ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button>
              Действия <ChevronDown size={14} aria-hidden="true" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" sideOffset={6} className="z-40 w-56 rounded-md border border-border-strong bg-surface p-1.5 shadow-panel">
              {actions.map((action) => (
                <DropdownMenu.Item
                  key={action.id}
                  onSelect={() => setDialog(action.id)}
                  className={`flex min-h-10 cursor-pointer items-center rounded-sm px-2 text-sm outline-none data-[highlighted]:bg-surface-raised ${action.tone === "danger" ? "text-danger" : "text-text"}`}
                >
                  {action.title}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : (
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {actions.map((action) => (
            <Button key={action.id} {...(action.tone === undefined ? {} : { tone: action.tone })} onClick={() => setDialog(action.id)}>
              {action.title}
            </Button>
          ))}
        </div>
      )}

      {canMessage ? <MessageDialog card={card} open={dialog === "message"} onOpenChange={(open) => setDialog(open ? "message" : null)} /> : null}
      {canWallet ? <WalletAdjustDialog card={card} open={dialog === "wallet"} onOpenChange={(open) => setDialog(open ? "wallet" : null)} onChanged={onChanged} /> : null}
      {(canRestrict || canBan) && catalog.state.status === "ok" ? (
        <>
          <RestrictDialog
            open={dialog === "restrict"}
            onOpenChange={(open) => setDialog(open ? "restrict" : null)}
            playerName={account.displayName}
            accountId={account.accountId}
            catalog={catalog.state.data}
            active={active}
            canBan={canBan}
            canRestrict={canRestrict}
            onDone={onChanged}
          />
          <RestrictDialog
            open={dialog === "ban"}
            onOpenChange={(open) => setDialog(open ? "ban" : null)}
            playerName={account.displayName}
            accountId={account.accountId}
            catalog={catalog.state.data}
            active={active}
            canBan={canBan}
            canRestrict={canRestrict}
            initialKinds={[BAN_KIND]}
            onDone={onChanged}
          />
        </>
      ) : null}
    </header>
  );
}

function CopyButton({ text }: { text: string }) {
  return (
    <button type="button" onClick={() => void copy(text)} className="rounded-sm px-1 text-accent hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent max-md:min-h-8">
      копировать
    </button>
  );
}
