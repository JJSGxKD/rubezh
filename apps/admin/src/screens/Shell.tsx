import type { AdminIdentity } from "../api/session";
import { hrefOf, resolveRoute, visibleSections } from "../routes";
import { useSession } from "../state/use-session";
import { Badge, Button, Notice } from "../ui/kit";
import { useHashRoute } from "../ui/router";
import { SECTION_SCREENS } from "./sections";

/** Каркас после входа: меню разделов по правам, шапка с аккаунтом и выходом. */
export function Shell({ identity }: { identity: AdminIdentity }) {
  const logout = useSession((state) => state.logout);
  const route = resolveRoute(useHashRoute(), identity.permissions);
  const sections = visibleSections(identity.permissions);
  const screen = route === null ? undefined : SECTION_SCREENS[route.section];

  return (
    <div className="grid min-h-screen grid-cols-[208px_1fr]">
      <nav className="flex flex-col gap-1 border-r border-border bg-surface-sunken p-3">
        <p className="px-2 pb-3 font-display text-base font-semibold">Рубеж</p>
        {sections.map((section) => (
          <a
            key={section.id}
            href={hrefOf({ section: section.id, id: null })}
            className={`rounded-sm px-2 py-1.5 text-sm ${route?.section === section.id ? "bg-surface-raised text-accent" : "text-text-muted hover:text-text"}`}
          >
            {section.title}
          </a>
        ))}
      </nav>
      <div className="flex min-w-0 flex-col">
        <header className="flex items-center justify-end gap-3 border-b border-border px-5 py-2.5">
          <span className="text-sm">{identity.account.displayName}</span>
          <span className="flex gap-1">
            {identity.roles.map((role) => (
              <Badge key={role} tone="accent">
                {role}
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
  );
}
