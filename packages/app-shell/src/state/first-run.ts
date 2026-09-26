import { HINT_ORDER, useHints } from "./hints";
import { useMeta } from "./meta";
import { useRuns } from "./runs";
import { useSession } from "./session";

/**
 * Играл ли аккаунт раньше — на этом или другом устройстве.
 *
 * Согласие с первым запуском и подсказки хранятся на устройстве, а аккаунт —
 * на сервере. Без этой проверки игрок, прошедший первый забег на ПК, на
 * телефоне снова попадал в учебный забег. Число забегов аккаунта приходит из
 * профиля (`useRuns.loadProfile` сливает его в `useMeta.runs`).
 *
 * Сервер спрашивается недолго: сессия на первом запуске может ещё
 * подниматься, но игрок, нажавший «Играть», ждать не должен. Не успели или
 * сети нет — считаем, что не играл: лишний учебный забег лучше, чем новичок
 * без обучения.
 */
export async function playedBefore(options: { timeoutMs?: number } = {}): Promise<boolean> {
  if (useMeta.getState().runs > 0) return true;
  const deadline = Date.now() + (options.timeoutMs ?? 2500);

  if (!(await sessionReady(deadline))) return false;
  const left = deadline - Date.now();
  if (left <= 0) return false;
  const loaded = await Promise.race([
    useRuns.getState().loadProfile().then((failure) => failure === null),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), left)),
  ]);
  return loaded && useMeta.getState().runs > 0;
}

/**
 * Подсказки первого забега — пройденными: аккаунт уже играл, управление он
 * знает. Вернуть их можно в настройках, как и раньше.
 */
export function skipFirstRunHints(): void {
  const hints = useHints.getState();
  for (const id of HINT_ORDER) hints.markSeen(id);
}

function sessionReady(deadline: number): Promise<boolean> {
  const status = useSession.getState().status;
  if (status === "ready") return Promise.resolve(true);
  if (status === "failed" || status === "idle") return Promise.resolve(false);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, Math.max(0, deadline - Date.now()));
    const unsubscribe = useSession.subscribe((state) => {
      if (state.status === "signing") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(state.status === "ready");
    });
  });
}
