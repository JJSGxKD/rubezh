import { create } from "zustand";
import { createId } from "./ids";
import { useShell } from "./shell";

/**
 * `installId` — идентификатор установки на устройстве. На этапе 2 авторизации
 * нет, и без него события закрытого теста нельзя разложить по устройствам
 * (docs/28-diagnostics.md §5.2). Создаётся один раз и живёт в хранилище.
 */
const INSTALL_KEY = "bh.install.v1.id";

/**
 * Версия текста предупреждения о тесте (docs/35-stage4-plan.md WP33). Меняется
 * вместе с текстом — экраном первого запуска и `i18n/ru-test-notice.json`:
 * новая версия показывается заново тем, кто принимал прежнюю.
 */
export const TEST_NOTICE_VERSION = 1;

export interface InstallStore {
  installId: string;
  /** принял ли игрок экран первого запуска на этом устройстве */
  accepted: boolean;
  /**
   * Какую версию предупреждения о тесте игрок принял на этом устройстве; 0 —
   * никакую. Сервер помнит принятие на аккаунт, а это — то, что ещё не дошло
   * до него: экран первого запуска открывается раньше входа.
   */
  noticeVersion: number;
  /** установка создана в этом запуске — первый запуск на устройстве */
  firstOpen: boolean;
  hydrate(): void;
  accept(): void;
  acceptNotice(version: number): void;
}

const ACCEPTED_KEY = "bh.install.v1.accepted";
const NOTICE_KEY = "bh.install.v1.testNotice";

export const useInstall = create<InstallStore>((set) => ({
  installId: "",
  accepted: false,
  noticeVersion: 0,
  firstOpen: false,

  hydrate(): void {
    const storage = useShell.getState().storage;
    const stored = storage?.get(INSTALL_KEY) ?? null;
    // Правдоподобие проверяется длиной, а не схемой: это одиночный скаляр,
    // и версия у него в имени ключа (docs/27-design-system-and-app-shell.md §7).
    const accepted = storage?.get(ACCEPTED_KEY) === "1";
    const notice = Number(storage?.get(NOTICE_KEY) ?? "0");
    const noticeVersion = Number.isInteger(notice) && notice > 0 ? notice : 0;
    if (stored !== null && stored.length >= 8 && stored.length <= 64) {
      set({ installId: stored, accepted, noticeVersion });
      return;
    }
    set({ accepted, noticeVersion });

    const installId = createId();
    storage?.set(INSTALL_KEY, installId);
    set({ installId, firstOpen: true });
  },

  /** Экран первого запуска несёт и предупреждение о тесте текущей версии. */
  accept(): void {
    const storage = useShell.getState().storage;
    storage?.set(ACCEPTED_KEY, "1");
    storage?.set(NOTICE_KEY, String(TEST_NOTICE_VERSION));
    set({ accepted: true, noticeVersion: TEST_NOTICE_VERSION });
  },

  acceptNotice(version): void {
    useShell.getState().storage?.set(NOTICE_KEY, String(version));
    set({ noticeVersion: version });
  },
}));
