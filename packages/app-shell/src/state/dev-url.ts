import { fxScene } from "../dev/fx-scenes";
import { SCREEN_IDS, type ScreenId } from "./navigation";

/**
 * Помощник для снимков экранов (`pnpm screens`, docs/17-testing-strategy.md
 * §8): адрес открывает нужный экран и входит под именем разработчика, чтобы не
 * кликать по стеку навигации. Работает только на dev-сервере и только с
 * локального хоста — через туннель адрес с `?dev-user=` достался бы любому.
 */
export interface DevUrlOptions {
  screen: ScreenId | null;
  devUser: string | null;
  /** id сцены стенда эффектов (`?fx=`, docs/17-testing-strategy.md) */
  fx: string | null;
  /** земля под сценой: карта или светлая проверочная (`&ground=light`) */
  ground: "map" | "light";
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);
/** Забегу нужен старт из листа, а стресс-тесту — своя подготовка: адресом их не открыть. */
const NOT_OPENABLE: ReadonlySet<ScreenId> = new Set<ScreenId>(["run", "stress"]);
const DEV_USER_MAX_LENGTH = 64;

const EMPTY: DevUrlOptions = { screen: null, devUser: null, fx: null, ground: "map" };

function isScreenId(value: string): value is ScreenId {
  return (SCREEN_IDS as readonly string[]).includes(value);
}

export function readDevUrl(href: string, isDev: boolean): DevUrlOptions {
  if (!isDev) return EMPTY;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return EMPTY;
  }
  if (!LOCAL_HOSTS.has(url.hostname)) return EMPTY;

  const rawScreen = url.searchParams.get("screen");
  let screen: ScreenId | null = null;
  if (rawScreen !== null && rawScreen !== "") {
    if (isScreenId(rawScreen) && !NOT_OPENABLE.has(rawScreen)) screen = rawScreen;
    else console.warn(`неизвестный экран в адресе: ${rawScreen}`);
  }

  const rawUser = url.searchParams.get("dev-user");
  const devUser = rawUser !== null && rawUser !== "" && rawUser.length <= DEV_USER_MAX_LENGTH ? rawUser : null;

  const rawFx = url.searchParams.get("fx");
  let fx: string | null = null;
  if (rawFx !== null && rawFx !== "") {
    if (fxScene(rawFx) !== null) fx = rawFx;
    else console.warn(`неизвестная сцена эффекта: ${rawFx}`);
  }
  const ground = url.searchParams.get("ground") === "light" ? "light" : "map";
  return { screen, devUser, fx, ground };
}
