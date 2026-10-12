import { useEffect, useState, type ReactNode } from "react";
import { Button, ContentColumn, ErrorState, InfoNotice, Screen } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/changelog";
import type { ApiFailure } from "../../state/api-request";
import { changelogAvailable, createChangelogApi, markChangelogSeen, type ChangelogVersion } from "../../state/changelog-api";
import { useNavigation } from "../../state/navigation";
import { track } from "../../state/shell";
import { VersionCard } from "./changelog-card";

/**
 * Журнал обновлений — «Что нового» (docs/35-stage4-plan.md Р61, WP31):
 * версии площадки игрока новыми сверху, внутри — новое, изменённое,
 * исправленное. Строку только для другой площадки сервер не отдаёт вовсе.
 * Открыл журнал — прочитано всё, что пришло в ответе; версия, вышедшая, пока
 * он открыт, останется новой до следующего раза.
 */

type Loaded = { status: "loading" } | { status: "failed"; failure: ApiFailure } | { status: "ready"; versions: ChangelogVersion[]; cursor: string | null };

const api = createChangelogApi();
export function ChangelogScreen(): ReactNode {
  const navigation = useNavigation();
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [more, setMore] = useState(false);

  const first = async (): Promise<number> => {
    setState({ status: "loading" });
    const response = await api.page(null);
    if (!response.ok) {
      setState({ status: "failed", failure: response.failure });
      return 0;
    }
    setState({ status: "ready", versions: response.data.versions, cursor: response.data.nextCursor });
    void markChangelogSeen(response.data, api);
    return response.data.versions.filter((version) => version.fresh).length;
  };

  useEffect(() => {
    if (!changelogAvailable()) return;
    // Откуда пришли — по стеку: из ленты по уведомлению о версии или из меню.
    const stack = useNavigation.getState().stack;
    const source = stack[stack.length - 2] === "notifications" ? "notification" : "menu";
    void first().then((fresh) => track("changelog_opened", { fresh, source }));
  }, []);

  const next = async (): Promise<void> => {
    if (state.status !== "ready" || state.cursor === null) return;
    setMore(true);
    const response = await api.page(state.cursor);
    setMore(false);
    if (response.ok) setState({ status: "ready", versions: [...state.versions, ...response.data.versions], cursor: response.data.nextCursor });
  };

  return (
    <Screen title={t("changelog.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        {changelogAvailable() ? null : <InfoNotice text={t("changelog.guest")} />}
        {state.status === "loading" && changelogAvailable() ? <p className="text-sm text-text-muted">{t("changelog.loading")}</p> : null}
        {state.status === "failed" ? <ErrorState text={t("changelog.failed")} onRetry={() => void first()} /> : null}
        {state.status === "ready" && state.versions.length === 0 ? <InfoNotice text={t("changelog.empty")} /> : null}
        {state.status === "ready" ? (
          <div className="grid gap-3">
            {state.versions.map((version, index) => (
              <VersionCard key={version.version} version={version} index={index} />
            ))}
            {state.cursor === null ? null : (
              <Button variant="secondary" block loading={more} onClick={() => void next()}>
                {t("changelog.more")}
              </Button>
            )}
          </div>
        ) : null}
      </ContentColumn>
    </Screen>
  );
}
