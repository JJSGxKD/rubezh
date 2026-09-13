import { create } from "zustand";
import { useShell } from "./shell";

/**
 * `installId` — идентификатор установки на устройстве. На этапе 2 авторизации
 * нет, и без него события закрытого теста нельзя разложить по устройствам
 * (docs/28-diagnostics.md §5.2). Создаётся один раз и живёт в хранилище.
 */
const INSTALL_KEY = "bh.install.v1.id";

export interface InstallStore {
  installId: string;
  /** принял ли игрок предупреждение о закрытом тесте */
  accepted: boolean;
  hydrate(): void;
  accept(): void;
}

const ACCEPTED_KEY = "bh.install.v1.accepted";

export const useInstall = create<InstallStore>((set) => ({
  installId: "",
  accepted: false,

  hydrate(): void {
    const storage = useShell.getState().storage;
    const stored = storage?.get(INSTALL_KEY) ?? null;
    // Правдоподобие проверяется длиной, а не схемой: это одиночный скаляр,
    // и версия у него в имени ключа (docs/27-design-system-and-app-shell.md §7).
    const accepted = storage?.get(ACCEPTED_KEY) === "1";
    if (stored !== null && stored.length >= 8 && stored.length <= 64) {
      set({ installId: stored, accepted });
      return;
    }
    set({ accepted });

    const installId = createId();
    storage?.set(INSTALL_KEY, installId);
    set({ installId });
  },

  accept(): void {
    useShell.getState().storage?.set(ACCEPTED_KEY, "1");
    set({ accepted: true });
  },
}));

/**
 * `crypto.randomUUID` есть не во всех WebView, а идентификатор установки
 * нужен всегда. Запасной путь — случайные байты из `crypto`, и только если
 * нет и его, `Math.random`: это не симуляция, детерминизм здесь не нужен.
 */
function createId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
