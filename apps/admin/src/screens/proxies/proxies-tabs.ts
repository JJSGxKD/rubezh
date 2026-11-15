import type { Route } from "../../routes";

/** Вкладки раздела «Прокси» (Р201): порядок — как панели стояли лентой. Новая вкладка — строка здесь и ветка в `ProxiesScreen`. */
export const PROXY_TABS = [
  { id: "xray", title: "Подписки Xray" },
  { id: "traffic", title: "Трафик" },
  { id: "core", title: "Ядро Xray" },
  { id: "manual", title: "Ручные прокси" },
  { id: "modes", title: "Режимы" },
] as const;

export type ProxyTab = (typeof PROXY_TABS)[number]["id"];

export const DEFAULT_PROXY_TAB: ProxyTab = "xray";

/** Вкладка из адреса; нет или чужая — «Подписки Xray». */
export function proxyTabOf(id: string | null | undefined): ProxyTab {
  return PROXY_TABS.find((tab) => tab.id === id)?.id ?? DEFAULT_PROXY_TAB;
}

/** Маршрут вкладки: по умолчанию — без хвоста, `#/proxies`. */
export function proxyTabRoute(tab: ProxyTab): Route {
  return { section: "proxies", id: tab === DEFAULT_PROXY_TAB ? null : tab };
}
