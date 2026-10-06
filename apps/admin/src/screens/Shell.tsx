import { useEffect } from "react";
import { roleName } from "../api/roles";
import type { AdminIdentity } from "../api/session";
import { hrefOf, locateSection, resolveRoute, visibleGroups } from "../routes";
import { useSession } from "../state/use-session";
import { Badge, Button, Notice } from "../ui/kit";
import { Toaster } from "../ui/toast";
import { useHashRoute } from "../ui/router";
import { SECTION_SCREENS } from "./sections";

const APP_TITLE = "Рубеж — панель";

/**
 * Каркас после входа: меню разделов группами по правам, шапка с тем, где
 * человек сейчас и что здесь делают, аккаунт и выход.
 */
export function Shell({ identity }: { identity: AdminIdentity }) {
  const logout = useSession((state) => state.logout);
  const route = resolveRoute(useHashRoute(), identity.permissions);
  const groups = visibleGroups(identity.permissions);
  const located = route === null ? null : locateSection(route.section);
  const screen = route === null ? undefined : SECTION_SCREENS[route.section];

  // Раздел — в заголовке вкладки: с пятью открытыми вкладками панели иначе
  // все они называются одинаково.
  const tabTitle = located === null ? APP_TITLE : `${located.section.title} · ${APP_TITLE}`;
  useEffect(() => {
    document.title = tabTitle;
  }, [tabTitle]);

  // На невысоком экране меню прокручивается само по себе — открытый по ссылке
  // «Аудит» не должен прятаться под его нижним краем.
  const sectionId = route?.section ?? null;
  useEffect(() => {
    document.querySelector('nav [aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  }, [sectionId]);

  // Уведомления — рядом с сеткой, а не в ней: третий ребёнок сетки заводит
  // вторую строку, и меню слева перестаёт доставать до низа окна.
  return (
    <>
      <div className="grid min-h-screen grid-cols-[208px_1fr]">
        {/* Меню прилипает к окну: в длинном списке игроков или журнале аудита
            оно не уезжает вверх вместе со страницей. */}
        <nav aria-label="Разделы панели" className="sticky top-0 flex h-screen flex-col overflow-y-auto border-r border-border bg-surface-sunken p-3">
          <p className="px-2 pb-1 font-display text-base font-semibold">Рубеж</p>
          {groups.map((group) => (
            <section key={group.title} aria-label={group.title} className="flex flex-col gap-0.5 pt-3">
              <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-text-disabled">{group.title}</h2>
              {group.sections.map((section) => {
                const active = route?.section === section.id;
                return (
                  <a
                    key={section.id}
                    href={hrefOf({ section: section.id, id: null })}
                    title={section.hint}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-sm px-2 py-1.5 text-sm ${active ? "bg-surface-raised text-accent" : "text-text-muted hover:bg-surface-raised/60 hover:text-text"}`}
                  >
                    {section.title}
                  </a>
                );
              })}
            </section>
          ))}
        </nav>
        <div className="flex min-w-0 flex-col">
          <header className="flex items-center gap-3 border-b border-border px-5 py-2.5">
            {located === null ? (
              <span className="mr-auto" />
            ) : (
              <p className="mr-auto flex min-w-0 items-baseline gap-2 text-sm">
                <span className="shrink-0 text-text-muted">{located.group.title}</span>
                <span className="shrink-0 text-text-disabled">/</span>
                <span className="shrink-0 font-medium">{located.section.title}</span>
                <span className="truncate text-xs text-text-muted">{located.section.hint}</span>
              </p>
            )}
            <span className="shrink-0 text-sm">{identity.account.displayName}</span>
            <span className="flex shrink-0 gap-1">
              {identity.roles.map((role) => (
                <Badge key={role} tone="accent">
                  {roleName(role)}
                </Badge>
              ))}
            </span>
            <Button onClick={() => void logout()}>Выйти</Button>
          </header>
          <main className="min-w-0 p-5">
            {route === null || screen === undefined ? (
              <Notice tone="info">Для ваших ролей в этой версии панели разделов нет.</Notice>
            ) : (
              screen(route.id)
            )}
          </main>
        </div>
      </div>
      <Toaster />
    </>
  );
}
