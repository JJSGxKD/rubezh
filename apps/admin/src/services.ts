import { AdminApi } from "./api/client";
import { createSessionStore } from "./state/session";

/**
 * Один клиент API и один стор сессии на приложение. Фабрики — в своих
 * модулях: тесты собирают их с поддельным `fetch`, а приложение — здесь.
 */
export const api = new AdminApi();
export const sessionStore = createSessionStore(api);
