import { useEffect, useState } from "react";

/**
 * Сколько оверлей не принимает нажатия после появления.
 *
 * Палец в этот момент ещё ведёт персонажа: без задержки тап по джойстику
 * выбирает улучшение за игрока и мгновенно закрывает экран смерти
 * (docs/26-stage2-plan.md, WP2). Анимация появления короче задержки — к
 * моменту, когда нажатие разрешено, карточки уже на месте.
 */
const GUARD_MS = 350;

export function useTapGuard(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setReady(true), GUARD_MS);
    return () => clearTimeout(timer);
  }, []);

  return ready;
}

/**
 * Обработчик, который до конца задержки молча ничего не делает. Кнопки при
 * этом не выключаются: иначе на треть секунды они серели бы и гасили ореол
 * ровно во время анимации появления.
 */
export function guarded(ready: boolean, action: () => void): () => void {
  return () => {
    if (ready) action();
  };
}
