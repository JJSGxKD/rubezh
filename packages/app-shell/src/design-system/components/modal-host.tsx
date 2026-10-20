import { createContext, useContext } from "react";

/**
 * Узел слоя модалок в корне приложения (Р119). Внутри `main` окно оказалось бы
 * в контексте наложения экрана (анимация `screen-in`) и в его границах: шапка
 * лежала бы поверх окна, а нижняя панель не затемнялась бы. Два состояния
 * разные: `undefined` — слоя нет вовсе (витрина, тесты), окно рисуется на
 * месте; `null` — слой есть, узел ещё не создан, окно ждёт.
 */
const ModalHostContext = createContext<HTMLElement | null | undefined>(undefined);

export const ModalHostProvider = ModalHostContext.Provider;

export function useModalHost(): HTMLElement | null | undefined {
  return useContext(ModalHostContext);
}
