import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { PreviewOptions, ServerOptions } from "vite";

/**
 * Настройки dev-сервера, общие для трёх площадок (docs/20-env-and-ports.md §4).
 *
 * До этого три конфигурации Vite держали одну и ту же логику туннеля тремя
 * копиями и расходились комментариями. Здесь она одна, а площадка передаёт
 * только то, чем отличается: свой порт, свою переменную с адресом туннеля и
 * прокси на локальный API (он есть лишь у Telegram).
 *
 * **Почему HTTPS.** Telegram открывает Mini App только по HTTPS и только с
 * действительным сертификатом — `http://localhost` не принимается именно
 * поэтому, а не из-за того, что адрес локальный. С доверенным сертификатом на
 * `127.0.0.1` десктопный клиент открывает dev-сборку без туннеля вовсе
 * (docs/34-stage3-plan.md, Р9).
 *
 * **Почему по умолчанию только петля.** `host: true` отдал бы несобранную
 * dev-сборку всей локальной сети, включая публичный Wi-Fi. Поэтому сеть
 * включается отдельной переменной `DEV_LAN_HOST` — для проверки с телефона,
 * и это сознательное исключение, а не умолчание (там же, Р9.1).
 */

export interface DevServerInput {
  /** переменные окружения из `loadEnv` корневого `.env` */
  env: Record<string, string>;
  /** корень монорепо: относительно него ищутся файлы сертификата */
  repoRoot: string;
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

export function devServerConfig({ env, repoRoot, port, tunnelHostVar, proxy }: DevServerInput): DevServerConfig {
  const tunnelHost = (env[tunnelHostVar] ?? "").trim();
  const lanHost = (env.DEV_LAN_HOST ?? "").trim();

  // Без этого Vite отклонит запрос с чужим заголовком Host.
  const hosts = [tunnelHost, lanHost].filter((host) => host !== "");
  const allowedHosts = hosts.length === 0 ? {} : { allowedHosts: hosts };

  // HMR идёт на тот же домен по wss через 443 — иначе клиент стучится на
  // localhost телефона и молча остаётся без обновлений. Для локальной сети
  // этого не нужно: домен и порт те же, что у страницы, и клиент Vite
  // соберёт адрес сам.
  const hmr = tunnelHost === "" ? {} : { hmr: { protocol: "wss" as const, host: tunnelHost, clientPort: 443 } };

  const https = certificate(env, repoRoot);

  const common = {
    port,
    strictPort: true,
    ...(proxy === undefined ? {} : { proxy }),
    ...allowedHosts,
    // Сертификат нужен и на просмотре собранной версии: замер
    // производительности идёт на прод-сборке (docs/25-week1-fps-trials.md),
    // а Telegram и её откроет только по HTTPS.
    ...https,
    ...listenHost(lanHost, https.https !== undefined),
  };

  return {
    server: { ...common, ...hmr },
    preview: common,
  };
}

/**
 * Что сервер слушает.
 *
 * Умолчание Vite — имя `localhost`, а на Windows оно резолвится в `::1`:
 * проверено, сервер поднимается только на IPv6-петле, и `https://127.0.0.1`
 * — ровно тот адрес, который вписан в BotFather, — не отвечает вовсе.
 * Поэтому с сертификатом слушаем IPv4-петлю явно; клиенты, пришедшие за
 * `localhost`, после отказа `::1` сами переходят на `127.0.0.1`.
 *
 * Адрес локальной сети перекрывает это: там нужны все интерфейсы.
 */
function listenHost(lanHost: string, https: boolean): { host?: true | "127.0.0.1" } {
  if (lanHost !== "") return { host: true };
  return https ? { host: "127.0.0.1" } : {};
}

/**
 * Сертификат разработки. Пара «сертификат + ключ» задаётся целиком или не
 * задаётся вовсе: половина пары — это не «работает как раньше», а опечатка,
 * которую лучше заметить при старте, чем в клиенте Telegram.
 *
 * Файлы лежат вне репозитория или в игнорируемом каталоге и в git не
 * попадают: закрытый ключ не коммитится, даже если он локальный.
 */
function certificate(env: Record<string, string>, repoRoot: string): { https?: { cert: Buffer; key: Buffer } } {
  const certPath = (env.DEV_HTTPS_CERT ?? "").trim();
  const keyPath = (env.DEV_HTTPS_KEY ?? "").trim();

  if (certPath === "" && keyPath === "") return {};
  if (certPath === "" || keyPath === "") {
    throw new Error(
      "DEV_HTTPS_CERT и DEV_HTTPS_KEY задаются вместе: с половиной пары сервер не поднимется (docs/20-env-and-ports.md §4)",
    );
  }

  return { https: { cert: readPem(certPath, repoRoot, "DEV_HTTPS_CERT"), key: readPem(keyPath, repoRoot, "DEV_HTTPS_KEY") } };
}

function readPem(path: string, repoRoot: string, variable: string): Buffer {
  const full = isAbsolute(path) ? path : resolve(repoRoot, path);
  try {
    return readFileSync(full);
  } catch {
    throw new Error(`${variable}: файл ${full} не читается — выпустите сертификат (docs/20-env-and-ports.md §4)`);
  }
}
