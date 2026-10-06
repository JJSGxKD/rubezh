import type { PlatformAdapter } from "@bh/shared-types";
import { useShell } from "./shell";

/**
 * Открыть внешнюю ссылку адаптером площадки — ссылку своей площадки внутри
 * её клиента, не закрывая игру, — а без него окном браузера. Звать в том же
 * нажатии: площадка открывает ссылки только в ответ на касание.
 */
export function openExternalLink(
  url: string,
  adapter: Pick<PlatformAdapter, "openLink"> = useShell.getState().adapter,
  browser: (url: string) => void = (link) => void globalThis.open(link, "_blank", "noopener"),
): void {
  if (adapter.openLink === undefined) browser(url);
  else adapter.openLink(url);
}
