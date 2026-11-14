import { articleGroups, type Article } from "../../../api/ledger-chart";
import { Badge, Button, Panel } from "../../../ui/kit";

/**
 * Статьи двумя списками: «Расходы» и «Поступления». Служебные (комиссии, налог, разница курсов) помечены и не
 * правятся: их заводит сервер, на них завязаны проводки.
 */
function ArticleList({
  title,
  articles,
  canEdit,
  notes,
  onRename,
  onArchive,
}: {
  title: string;
  articles: readonly Article[];
  canEdit: boolean;
  notes: Readonly<Record<string, string>>;
  onRename: (article: Article) => void;
  onArchive: (article: Article) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {articles.length === 0 ? (
        <p className="text-sm text-text-muted">Статей пока нет</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {articles.map((article) => (
            <li key={article.articleId} className="flex flex-col gap-1 border-b border-border pb-2 last:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm">
                  {article.name}
                  {article.system ? <Badge>служебная</Badge> : null}
                </span>
                {canEdit && !article.system ? (
                  <span className="flex gap-2">
                    <Button onClick={() => onRename(article)}>Переименовать</Button>
                    <Button onClick={() => onArchive(article)}>В архив</Button>
                  </span>
                ) : null}
              </div>
              {notes[article.articleId] === undefined ? null : (
                <p role="alert" className="text-xs text-danger">
                  {notes[article.articleId]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ArticlesView({
  articles,
  canEdit,
  notes,
  onAdd,
  onRename,
  onArchive,
}: {
  articles: readonly Article[];
  canEdit: boolean;
  notes: Readonly<Record<string, string>>;
  onAdd: () => void;
  onRename: (article: Article) => void;
  onArchive: (article: Article) => void;
}) {
  const groups = articleGroups(articles);
  return (
    <Panel title="Статьи" help="По статьям проводки раскладываются в отчёте: расходы — куда ушли деньги, поступления — откуда пришли" actions={canEdit ? <Button onClick={onAdd}>Добавить статью</Button> : undefined}>
      <div className="grid gap-6 md:grid-cols-2">
        <ArticleList title="Расходы" articles={groups.expense} canEdit={canEdit} notes={notes} onRename={onRename} onArchive={onArchive} />
        <ArticleList title="Поступления" articles={groups.income} canEdit={canEdit} notes={notes} onRename={onRename} onArchive={onArchive} />
      </div>
    </Panel>
  );
}
