import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, LogOut, Menu, Search, X } from "lucide-react";
import { Dialog, DropdownMenu } from "radix-ui";
import { roleName } from "../api/roles";
import type { AdminIdentity } from "../api/session";
import { filterGroups, hrefOf, locateSection, resolveRoute, visibleGroups, type Route, type SectionGroup } from "../routes";
import { useSession } from "../state/use-session";
import { Badge, Notice } from "../ui/kit";
import { Toaster } from "../ui/toast";
import { useHashRoute } from "../ui/router";
import { useNarrow } from "../ui/use-media";
import { SECTION_SCREENS } from "./sections";

const APP_TITLE = "Рубеж — панель";

/**
 * Каркас после входа: меню разделов группами по правам со значками и поиском,
 * шапка с тем, где человек сейчас и что здесь делают, меню аккаунта. До 768 px
 * (`useNarrow`) — телефон: шапка с кнопкой меню, меню листом слева, отступы
 * поменьше. Экраны разделов о ширине не знают: таблицы и окна подстраивают
 * `DataTable` и `Dialog`.
 */
export function Shell({ identity }: { identity: AdminIdentity }) {
  const narrow = useNarrow();
  const hashRoute = useHashRoute();
  const route = resolveRoute(hashRoute, identity.permissions);
  const groups = visibleGroups(identity.permissions);
  const located = route === null ? null : locateSection(route.section);
  const screen = route === null ? undefined : SECTION_SCREENS[route.section];
  const [query, setQuery] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Раздел — в заголовке вкладки: с пятью открытыми вкладками панели иначе
  // все они называются одинаково.
  const tabTitle = located === null ? APP_TITLE : `${located.section.title} · ${APP_TITLE}`;
  useEffect(() => {
    document.title = tabTitle;
  }, [tabTitle]);

  // На невысоком экране меню прокручивается само по себе — открытый по ссылке
  // «Аудит» не должен прятаться под его нижним краем. На телефоне колонка меню
  // появляется только при открытии листа, поэтому прокрутка нужна и тогда; кадр
  // ждёт, пока колонка отрисуется.
  const sectionId = route?.section ?? null;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.querySelector('nav [aria-current="page"]')?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [sectionId, sheetOpen]);

  // «Назад» в браузере и любой переход закрывают лист меню: маршрут сменился.
  const hash = hashRoute === null ? "" : hrefOf(hashRoute);
  useEffect(() => {
    setSheetOpen(false);
  }, [hash]);

  // Клавиша «/» вне полей ввода — курсор в поиск раздела.
  useEffect(() => {
    if (narrow) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [narrow]);

  const content =
    route === null || screen === undefined ? <Notice tone="info">Для ваших ролей в этой версии панели разделов нет.</Notice> : screen(route.id);

  // Уведомления — рядом с сеткой, а не в ней: третий ребёнок сетки заводит
  // вторую строку, и меню слева перестаёт доставать до низа окна.
  if (narrow) {
    return (
      <>
        <div className="flex min-h-screen min-w-0 flex-col">
          <header className="sticky top-0 z-30 flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-bg px-3">
            <Dialog.Root open={sheetOpen} onOpenChange={setSheetOpen}>
              <Dialog.Trigger aria-label="Меню разделов" className="grid size-9 shrink-0 place-items-center rounded-md border border-border text-text">
                <Menu size={18} aria-hidden="true" />
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
                <Dialog.Content
                  aria-describedby={undefined}
                  // Курсор в поиск при открытии поднял бы экранную клавиатуру поверх меню.
                  onOpenAutoFocus={(event) => event.preventDefault()}
                  className="fixed inset-y-0 left-0 z-40 flex w-[300px] max-w-[85vw] flex-col border-r border-border-strong bg-surface-sunken focus:outline-none"
                >
                  <Dialog.Title className="sr-only">Разделы панели</Dialog.Title>
                  <div className="flex items-center justify-between px-3 pt-3">
                    <Brand />
                    <Dialog.Close aria-label="Закрыть меню" className="grid size-9 place-items-center rounded-md text-text-muted">
                      <X size={18} aria-hidden="true" />
                    </Dialog.Close>
                  </div>
                  <MenuColumn groups={groups} route={route} query={query} onQuery={setQuery} searchRef={searchRef} onNavigate={() => setSheetOpen(false)} />
                  <div className="border-t border-border p-3">
                    <AccountBlock identity={identity} />
                  </div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
            <h1 className="min-w-0 flex-1 truncate font-display text-base">{located?.section.title ?? APP_TITLE}</h1>
          </header>
          <main className="min-w-0 flex-1 p-3">{content}</main>
        </div>
        <Toaster />
      </>
    );
  }

  return (
    <>
      <div className="grid min-h-screen grid-cols-[216px_1fr]">
        {/* Меню прилипает к окну: в длинном списке игроков или журнале аудита
            оно не уезжает вверх вместе со страницей. */}
        <aside className="sticky top-0 flex h-screen flex-col border-r border-border bg-surface-sunken">
          <div className="px-3 pt-3">
            <Brand />
          </div>
          <MenuColumn groups={groups} route={route} query={query} onQuery={setQuery} searchRef={searchRef} />
        </aside>
        <div className="flex min-w-0 flex-col">
          <header className="flex items-center gap-3 border-b border-border px-5 py-2.5">
            {located === null ? (
              <span className="mr-auto" />
            ) : (
              <p className="mr-auto flex min-w-0 items-baseline gap-2 text-sm">
                <span className="shrink-0 text-text-muted">{located.group.title}</span>
                <span aria-hidden="true" className="shrink-0 text-text-disabled">/</span>
                <span className="shrink-0 font-display text-[17px]">{located.section.title}</span>
                <span className="truncate text-xs text-text-muted">{located.section.hint}</span>
              </p>
            )}
            <AccountMenu identity={identity} />
          </header>
          <main className="min-w-0 p-5">{content}</main>
        </div>
      </div>
      <Toaster />
    </>
  );
}

/** Печатают ли сейчас в поле: тогда «/» — просто символ, а не горячая клавиша. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function Brand() {
  return (
    <p className="flex items-center gap-2 px-1 pb-1 font-display text-base">
      <span aria-hidden="true" className="size-[22px] rounded-sm bg-gradient-to-br from-accent to-[#c45a1e]" />
      Рубеж
    </p>
  );
}

/** Поиск и группы разделов — одно содержимое и для колонки на ПК, и для листа на телефоне. */
function MenuColumn({
  groups,
  route,
  query,
  onQuery,
  searchRef,
  onNavigate,
}: {
  groups: SectionGroup[];
  route: Route | null;
  query: string;
  onQuery: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Лист меню на телефоне закрывается выбором раздела, в том числе уже открытого: тот же адрес `hashchange` не даёт. */
  onNavigate?: () => void;
}) {
  const shown = filterGroups(groups, query);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 p-3 pt-2">
      <label className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-text-muted focus-within:border-accent">
        <Search size={14} aria-hidden="true" />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onQuery("");
          }}
          placeholder="Найти раздел"
          aria-label="Найти раздел"
          maxLength={64}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-disabled"
        />
        <kbd className="rounded-sm border border-border-strong px-1 text-[10.5px] leading-4 text-text-muted max-md:hidden">/</kbd>
      </label>
      <nav aria-label="Разделы панели" className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? <p className="px-2 pt-3 text-xs text-text-muted">Такого раздела нет</p> : null}
        {shown.map((group) => (
          <section key={group.title} aria-label={group.title} className="flex flex-col gap-0.5 pt-3">
            <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-text-muted">{group.title}</h2>
            {group.sections.map((section) => {
              const active = route?.section === section.id;
              const Icon = section.icon;
              return (
                <a
                  key={section.id}
                  href={hrefOf({ section: section.id, id: null })}
                  title={section.hint}
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  className={`flex h-[30px] items-center gap-2 rounded-sm px-2 text-[13.5px] max-md:h-10 ${
                    active ? "bg-surface-raised text-text shadow-[inset_2px_0_0_var(--color-accent)]" : "text-text-muted hover:bg-surface-raised/60 hover:text-text"
                  }`}
                >
                  <Icon size={16} aria-hidden="true" className={active ? "text-accent" : ""} />
                  {section.title}
                </a>
              );
            })}
          </section>
        ))}
      </nav>
    </div>
  );
}

/** Первая буква имени в кружке — аватара у аккаунта панели нет. */
function Avatar({ name }: { name: string }) {
  return (
    <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-raised font-display text-xs text-accent">
      {name.trim().slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}

/** Меню аккаунта в шапке ПК: роли бейджами и «Выйти». */
function AccountMenu({ identity }: { identity: AdminIdentity }) {
  const logout = useSession((state) => state.logout);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">
        <Avatar name={identity.account.displayName} />
        <span className="max-w-40 truncate">{identity.account.displayName}</span>
        <ChevronDown size={14} aria-hidden="true" className="text-text-muted" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-40 w-64 rounded-md border border-border-strong bg-surface p-2 shadow-panel">
          <div className="flex flex-col gap-1.5 px-2 pb-2">
            <p className="truncate text-sm font-medium">{identity.account.displayName}</p>
            <span className="flex flex-wrap gap-1">
              {identity.roles.map((role) => (
                <Badge key={role} tone="accent">
                  {roleName(role)}
                </Badge>
              ))}
            </span>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            onSelect={() => void logout()}
            className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-surface-raised"
          >
            <LogOut size={14} aria-hidden="true" />
            Выйти
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Аккаунт внизу листа на телефоне: те же роли и «Выйти», но без выпадающего меню. */
function AccountBlock({ identity }: { identity: AdminIdentity }) {
  const logout = useSession((state) => state.logout);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Avatar name={identity.account.displayName} />
        <span className="min-w-0 flex-1 truncate text-sm">{identity.account.displayName}</span>
      </div>
      <span className="flex flex-wrap gap-1">
        {identity.roles.map((role) => (
          <Badge key={role} tone="accent">
            {roleName(role)}
          </Badge>
        ))}
      </span>
      <button type="button" onClick={() => void logout()} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-sm border border-border bg-surface-raised text-sm">
        <LogOut size={14} aria-hidden="true" />
        Выйти
      </button>
    </div>
  );
}
