import { useSyncExternalStore } from "react";
import { hrefOf, parseRoute, type Route } from "../routes";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** Маршрут из хэша адреса; перерисовка — только при его смене. */
export function useHashRoute(): Route | null {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}

export function navigate(route: Route): void {
  window.location.hash = hrefOf(route);
}
