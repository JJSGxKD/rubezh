import { useState } from "react";
import {
  archiveArticle,
  archivePlace,
  archiveTemplate,
  currentPeriod,
  draftPeriod,
  draftSummary,
  loadArticles,
  loadPlaces,
  loadTemplates,
  type Article,
  type Place,
  type Template,
} from "../../../api/ledger-chart";
import type { ApiResult } from "../../../api/client";
import { api } from "../../../services";
import { can } from "../../../state/session";
import { useSession } from "../../../state/use-session";
import { Button, ErrorNotice, Loading } from "../../../ui/kit";
import { toast, toastError } from "../../../ui/toast";
import { useApi } from "../../../ui/use-api";
import { ArticleDialog } from "./ArticleDialog";
import { ArticlesView } from "./ArticlesView";
import { PlaceDialog } from "./PlaceDialog";
import { PlacesView } from "./PlacesView";
import { TemplateDialog } from "./TemplateDialog";
import { TemplatesView } from "./TemplatesView";

/**
 * Вкладки «Места и статьи» и «Шаблоны» (docs/29-admin-panel.md §6.7, Р220, tasks/T-0465). Читает тот, кто видит
 * раздел (`ledger.view`), менять — `finance.entry.create`. Архив вместо удаления: отказ сервера (остаток на месте,
 * служебное) остаётся словами под кнопкой.
 */

function useCanEdit(): boolean {
  return useSession((session) => can(session.view, "finance.entry.create"));
}

/** Архив одной записи: успех перезагружает список, отказ — строкой под кнопкой этой записи. */
function useArchive(reload: () => void) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const run = async (id: string, call: () => Promise<ApiResult<{ ok: true }>>): Promise<void> => {
    setNotes((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
    const result = await call();
    if (result.ok) {
      reload();
      return;
    }
    if (result.error.kind === "rejected") setNotes((current) => ({ ...current, [id]: result.error.message }));
    else toastError(result.error);
  };
  return { notes, run };
}

export function ChartTab() {
  const canEdit = useCanEdit();
  const places = useApi(() => loadPlaces(api), []);
  const articles = useApi(() => loadArticles(api), []);
  const reloadAll = () => {
    places.reload();
    articles.reload();
  };
  const placeArchive = useArchive(reloadAll);
  const articleArchive = useArchive(reloadAll);
  const [placeDialog, setPlaceDialog] = useState<Place | "new" | null>(null);
  const [articleDialog, setArticleDialog] = useState<Article | "new" | null>(null);

  if (places.state.status === "loading" || articles.state.status === "loading") return <Loading />;
  if (places.state.status === "error") return <ErrorNotice error={places.state.error} onRetry={places.reload} />;
  if (articles.state.status === "error") return <ErrorNotice error={articles.state.error} onRetry={articles.reload} />;

  return (
    <div className="flex flex-col gap-4">
      <PlacesView
        places={places.state.data.places}
        canEdit={canEdit}
        notes={placeArchive.notes}
        onAdd={() => setPlaceDialog("new")}
        onEdit={setPlaceDialog}
        onArchive={(place) => void placeArchive.run(place.placeId, () => archivePlace(api, place.placeId))}
      />
      <ArticlesView
        articles={articles.state.data.articles}
        canEdit={canEdit}
        notes={articleArchive.notes}
        onAdd={() => setArticleDialog("new")}
        onRename={setArticleDialog}
        onArchive={(article) => void articleArchive.run(article.articleId, () => archiveArticle(api, article.articleId))}
      />
      {placeDialog === null ? null : <PlaceDialog place={placeDialog === "new" ? null : placeDialog} onClose={() => setPlaceDialog(null)} onSaved={reloadAll} />}
      {articleDialog === null ? null : <ArticleDialog article={articleDialog === "new" ? null : articleDialog} onClose={() => setArticleDialog(null)} onSaved={reloadAll} />}
    </div>
  );
}

export function TemplatesTab() {
  const canEdit = useCanEdit();
  const templates = useApi(() => loadTemplates(api), []);
  const places = useApi(() => loadPlaces(api), []);
  const articles = useApi(() => loadArticles(api), []);
  const archive = useArchive(templates.reload);
  const [dialog, setDialog] = useState<Template | "new" | null>(null);
  const [drafting, setDrafting] = useState(false);

  if (templates.state.status === "loading" || places.state.status === "loading" || articles.state.status === "loading") return <Loading />;
  if (templates.state.status === "error") return <ErrorNotice error={templates.state.error} onRetry={templates.reload} />;
  if (places.state.status === "error") return <ErrorNotice error={places.state.error} onRetry={places.reload} />;
  if (articles.state.status === "error") return <ErrorNotice error={articles.state.error} onRetry={articles.reload} />;

  const draft = async () => {
    setDrafting(true);
    const result = await draftPeriod(api, currentPeriod());
    setDrafting(false);
    if (!result.ok) {
      toastError(result.error, "Не удалось создать расходы месяца");
      return;
    }
    toast(`Расходы месяца: ${draftSummary(result.data)}`);
  };

  return (
    <div className="flex flex-col gap-4">
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={drafting} onClick={() => void draft()}>
            {drafting ? "Создаём…" : "Расходы месяца"}
          </Button>
          <span className="text-xs text-text-muted">Черновики операций по шаблонам текущего месяца; повтор дублей не создаёт</span>
        </div>
      ) : null}
      <TemplatesView
        templates={templates.state.data.templates}
        canEdit={canEdit}
        notes={archive.notes}
        onAdd={() => setDialog("new")}
        onEdit={setDialog}
        onArchive={(template) => void archive.run(template.templateId, () => archiveTemplate(api, template.templateId))}
      />
      {dialog === null ? null : (
        <TemplateDialog
          template={dialog === "new" ? null : dialog}
          places={places.state.data.places}
          articles={articles.state.data.articles}
          onClose={() => setDialog(null)}
          onSaved={templates.reload}
        />
      )}
    </div>
  );
}
