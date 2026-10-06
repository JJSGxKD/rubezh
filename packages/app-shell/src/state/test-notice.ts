import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { TEST_NOTICE_VERSION, useInstall } from "./install";
import { currentScreen, useNavigation } from "./navigation";
import { track } from "./shell";

/**
 * Предупреждение об открытом тесте (docs/35-stage4-plan.md Р59, WP33): данные
 * могут не сохраниться, вайп компенсируем бонусом, купленное за деньги не
 * пропадёт. Каждый игрок должен увидеть его до первой покупки.
 *
 * Новичок видит его на экране первого запуска — раньше первого забега, где
 * уже можно купить второй шанс; принятие там запоминается на устройстве и
 * уходит на сервер, когда появится сессия. Игрок, прошедший первый запуск
 * до предупреждения, получает его отдельным экраном — в лобби, а не поверх
 * забега. Сервер помнит принятие на аккаунт: на втором устройстве не спросят.
 *
 * Модуль грузится после входа — первой загрузке он не нужен.
 */

const viewSchema = z.object({ acceptedVersion: z.nullable(z.number()) });

export interface TestNoticeApi {
  view(): Promise<ApiResult<z.infer<typeof viewSchema>>>;
  accept(version: number): Promise<ApiResult<z.infer<typeof viewSchema>>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createTestNoticeApi(request: ApiRequest = apiRequest): TestNoticeApi {
  return {
    view: () => request("/api/v1/me/test-notice", viewSchema, { method: "GET" }),
    accept: (version) => request("/api/v1/me/test-notice", viewSchema, { method: "POST", body: { version } }),
  };
}

let stopWaiting: (() => void) | null = null;

/**
 * После входа: сервер уже знает о принятии — ничего; принято на устройстве —
 * досылается; не принято нигде — экран в лобби, как только игрок там.
 */
export async function syncTestNotice(api: TestNoticeApi = createTestNoticeApi()): Promise<void> {
  const view = await api.view();
  if (!view.ok || (view.data.acceptedVersion ?? 0) >= TEST_NOTICE_VERSION) return;
  if (useInstall.getState().noticeVersion >= TEST_NOTICE_VERSION) {
    await report(api);
    return;
  }
  waitForLobby(api);
}

/**
 * Игрок нажал «Понятно»: принятие запоминается на устройстве сразу — сеть
 * могла пропасть, а спрашивать второй раз незачем, — и уходит на сервер.
 */
export async function acceptTestNotice(api: TestNoticeApi = createTestNoticeApi()): Promise<boolean> {
  useInstall.getState().acceptNotice(TEST_NOTICE_VERSION);
  return await report(api);
}

async function report(api: TestNoticeApi): Promise<boolean> {
  const response = await api.accept(TEST_NOTICE_VERSION);
  if (response.ok) track("test_notice_accepted", { version: TEST_NOTICE_VERSION });
  return response.ok;
}

/**
 * Экран — только в лобби: поверх забега он сорвал бы бой, а на экране
 * первого запуска предупреждение и так есть. Принял его там, пока ждали, —
 * экран не нужен, принятие досылается.
 */
function waitForLobby(api: TestNoticeApi): void {
  stopWaiting?.();
  const check = (): void => {
    const install = useInstall.getState();
    if (install.noticeVersion >= TEST_NOTICE_VERSION) {
      stop();
      void report(api);
      return;
    }
    if (!install.accepted || currentScreen(useNavigation.getState().stack) !== "lobby") return;
    stop();
    useNavigation.getState().push("testNotice");
  };
  const unsubscribers = [useNavigation.subscribe(check), useInstall.subscribe(check)];
  const stop = (): void => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    stopWaiting = null;
  };
  stopWaiting = stop;
  check();
}
