import type { ReactNode } from "react";
import { Badge, Card } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/changelog";
import { entriesByKind, type ChangelogVersion } from "../../state/changelog-api";

/**
 * Карточка версии в «Что нового» (docs/35-stage4-plan.md WP31): своим
 * модулем, потому что её же рисует предпросмотр в панели (WP32) — команда
 * видит версию так, как увидит игрок, до публикации.
 */

const DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const DATE_YEAR = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });

/** Дата выхода: год — только у прошлогодних, иначе строка версии не влезает в 320 px. */
function releaseDate(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  return (date.getFullYear() === new Date().getFullYear() ? DATE : DATE_YEAR).format(date);
}

export function VersionCard(props: { version: ChangelogVersion; index: number }): ReactNode {
  const { version } = props;
  return (
    <Card appearIndex={Math.min(props.index, 6)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="font-display text-base font-semibold">{t("changelog.version", { version: version.version })}</h2>
        {version.fresh ? <Badge tone="accent">{t("changelog.fresh")}</Badge> : null}
        <span className="ml-auto text-xs text-text-muted">{releaseDate(version.publishedAt)}</span>
      </div>
      {entriesByKind(version).map((group) => (
        <section key={group.kind} className="mt-3">
          <h3 className="font-display text-xs font-semibold tracking-wide text-text-muted uppercase">{kindTitle(group.kind)}</h3>
          <ul className="mt-1 grid gap-1.5">
            {group.texts.map((entry) => (
              <li key={entry.id} className="flex gap-2 text-sm">
                <span aria-hidden="true" className={`mt-2 size-1.5 shrink-0 rounded-full ${kindDot(group.kind)}`} />
                {/* Переносы строк — как их набрали в панели. */}
                <span className="min-w-0 flex-1 whitespace-pre-line break-words">{entry.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Card>
  );
}

/** Незнакомый вид — без заголовка вида: строка важнее подписи, которой клиент ещё не знает. */
function kindTitle(kind: string): string {
  return kind === "added" || kind === "changed" || kind === "fixed" ? t(`changelog.kind.${kind}`) : "";
}

function kindDot(kind: string): string {
  if (kind === "added") return "bg-accent";
  if (kind === "fixed") return "bg-success";
  return "bg-info";
}
