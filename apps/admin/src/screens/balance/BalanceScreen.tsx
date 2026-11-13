import { fetchDiff, fetchDraft, fetchDrafts, fetchVersion, fetchVersions, latestVersion, type ContentVersion, type DraftDetail, type DraftDiff, type DraftSummary, type VersionSummary } from "../../api/content";
import type { ApiError, ApiResult } from "../../api/client";
import { api } from "../../services";
import { useSession } from "../../state/use-session";
import { Button, ErrorNotice, Loading, Notice } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { useApi, type Loaded } from "../../ui/use-api";
import { BalanceWorkspace } from "./BalanceWorkspace";

/**
 * Баланс: числа игры в черновике (docs/19-content-admin.md §3, tasks/T-0304).
 * Экран только грузит — версии, черновики, выбранный черновик с его разницей и
 * версию-основу, — а работает с ними `BalanceWorkspace`. Адрес `#/balance/<черновик>`:
 * без черновика показана версия «в игре», только чтение.
 */
export function BalanceScreen({ id, tab }: { id: string | null; tab?: string | undefined }) {
  const versions = useApi(() => fetchVersions(api), []);
  const drafts = useApi(() => fetchDrafts(api), []);

  if (versions.state.status === "error") return <ErrorNotice error={versions.state.error} onRetry={versions.reload} />;
  if (drafts.state.status === "error") return <ErrorNotice error={drafts.state.error} onRetry={drafts.reload} />;
  if (versions.state.status === "loading" || drafts.state.status === "loading") return <Loading />;

  const latest = latestVersion(versions.state.data);
  if (latest === null) return <Notice tone="info">Версий контента ещё нет — версию 0 заводит команда content:import при выкате.</Notice>;
  return <Session key={id ?? "base"} id={id} tab={tab} latest={latest} drafts={drafts.state.data} reloadDrafts={drafts.reload} />;
}

/** Нужного нет вовсе (черновик не выбран): не запрос, а готовое «ничего». */
async function optional<T>(id: string | null, load: (id: string) => Promise<ApiResult<T>>): Promise<ApiResult<T | null>> {
  return id === null ? { ok: true, data: null } : await load(id);
}

/** Основа ещё неизвестна: ждать нечего, запрос не уходит, пока не придёт черновик. */
const WAITING_FOR_DRAFT = new Promise<never>(() => undefined);

function failed<T>(state: Loaded<T>): state is { status: "error"; error: ApiError } {
  return state.status === "error";
}

function Session({ id, tab, latest, drafts, reloadDrafts }: { id: string | null; tab: string | undefined; latest: VersionSummary; drafts: DraftSummary[]; reloadDrafts: () => void }) {
  const canEdit = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("content.edit"));
  const meId = useSession((session) => (session.view.status === "ready" ? session.view.identity.account.accountId : ""));

  const draft = useApi<DraftDetail | null>(() => optional(id, (value) => fetchDraft(api, value)), [id]);
  const diff = useApi<DraftDiff | null>(() => optional(id, (value) => fetchDiff(api, value)), [id]);
  const baseNo = id === null ? latest.versionNo : draft.state.status === "ok" && draft.state.data !== null ? draft.state.data.baseVersionNo : null;
  const version = useApi<ContentVersion>(() => (baseNo === null ? WAITING_FOR_DRAFT : fetchVersion(api, baseNo)), [baseNo]);

  if (failed(draft.state)) return <FailedDraft error={draft.state.error} onRetry={draft.reload} />;
  if (failed(diff.state)) return <FailedDraft error={diff.state.error} onRetry={diff.reload} />;
  if (failed(version.state)) return <FailedDraft error={version.state.error} onRetry={version.reload} />;
  if (draft.state.status !== "ok" || diff.state.status !== "ok" || version.state.status !== "ok") return <Loading />;

  return (
    <BalanceWorkspace
      latest={latest}
      drafts={drafts}
      reloadDrafts={reloadDrafts}
      version={version.state.data}
      draft={draft.state.data}
      diff={diff.state.data}
      canEdit={canEdit}
      meId={meId}
      initialTab={tab}
    />
  );
}

function FailedDraft({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <ErrorNotice error={error} onRetry={onRetry} />
      <Button onClick={() => navigate({ section: "balance", id: null })}>К версии в игре</Button>
    </div>
  );
}
