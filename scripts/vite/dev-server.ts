import type { PreviewOptions, ServerOptions } from "vite";

/**
 * Настройки dev-сервера, общие для трёх площадок (docs/20-env-and-ports.md §4).
 *
 * До этого три конфигурации Vite держали одну и ту же логику туннеля тремя
 * копиями и расходились комментариями. Здесь она одна, а площадка передаёт
 * только то, чем отличается: свой порт, свою переменную с адресом туннеля и
 * прокси на локальный API (он есть лишь у Telegram).
 *
 * Сервер слушает **только петлю**: `host: true` отдал бы несобранную
 * dev-сборку всей локальной сети, включая публичный Wi-Fi. Наружу его
 * выводит `frpc`.
 */

export interface DevServerInput {
  /** переменные окружения из `loadEnv` корневого `.env` */
  env: Record<string, string>;
  /** порт площадки из карты портов (docs/20-env-and-ports.md §2) */
  port: number;
  /** имя переменной с адресом туннеля площадки: `DEV_TUNNEL_TELEGRAM_HOST` и т. п. */
  tunnelHostVar: string;
  /** прокси на локальный API — только у Telegram */
  proxy?: ServerOptions["proxy"];
}

export interface DevServerConfig {
  server: ServerOptions;
  preview: PreviewOptions;
}

export function devServerConfig({ env, port, tunnelHostVar, proxy }: DevServerInput): DevServerConfig {
  const tunnelHost = (env[tunnelHostVar] ?? "").trim();

  // Без этого Vite отклонит запрос с чужим заголовком Host.
  const allowedHosts = tunnelHost === "" ? {} : { allowedHosts: [tunnelHost] };

  // HMR идёт на тот же домен по wss через 443 — иначе клиент стучится на
  // localhost телефона и молча остаётся без обновлений.
  const hmr = tunnelHost === "" ? {} : { hmr: { protocol: "wss" as const, host: tunnelHost, clientPort: 443 } };

  const common = { port, strictPort: true, ...(proxy === undefined ? {} : { proxy }), ...allowedHosts };

  return {
    server: { ...common, ...hmr },
    preview: common,
  };
}
