import type { AdFailureReason, NetworkTaskHandle, NetworkTaskMount, NetworkTaskPart, NetworkTaskState } from "@bh/shared-types";
import { ADSGRAM_SCRIPT } from "./networks";
import { browserScriptLoader, type ScriptLoader } from "./script-loader";

/**
 * Задание AdsGram во вкладке «Партнёры» (docs/35-stage4-plan.md WP13, часть
 * 6): элемент `<adsgram-task>` из того же скрипта, что ролики AdsGram. Он сам
 * берёт задание у сети, рисует иконку и заголовок, ведёт игрока и проверяет
 * выполнение; наши — только слоты: награда, «Перейти», «Забрать», «Готово».
 *
 * Контракт элемента — по типам самой сети (`@adsgram/common` 1.0.2:
 * `AdsgramTaskCustomEventMap`) и рабочей интеграции `vpnsibcom_web`
 * (`TaskAdsgram.tsx`). Перенос — адаптация: в источнике награду давало
 * событие клиента, и её можно было вызвать из консоли; здесь событие
 * `reward` только говорит оболочке обновить экран, а награду даёт сервер
 * по адресу награды AdsGram.
 *
 * Готовность: у сети нет события «задание показано», поэтому «на экране» —
 * это первый ненулевой размер элемента: пока задания нет, ему нечего
 * рисовать. Не появилось за срок — считаем, что задания нет.
 */

const TASK_TAG = "adsgram-task";

/** Слоты элемента AdsGram под наши узлы. */
const SLOTS: Readonly<Record<NetworkTaskPart, string>> = { reward: "reward", open: "button", claim: "claim", done: "done" };

/** События элемента — `AdsgramTaskCustomEventMap`. */
const EVENTS = { reward: "reward", notFound: "onBannerNotFound", error: "onError", stale: "onTooLongSession" } as const;

/** Сколько ждём, пока скрипт объявит элемент. */
export const DEFINE_TIMEOUT_MS = 10_000;
/** Сколько ждём, пока элемент нарисует задание; дольше — задания нет. */
export const READY_TIMEOUT_MS = 8_000;

/** Ровно то из DOM, что нужно заданию, — в тестах подменяется. */
export interface TaskElement {
  setAttribute(name: string, value: string): void;
  style: { setProperty(name: string, value: string): void };
  append(...nodes: HTMLElement[]): void;
  remove(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface TaskDom {
  create(tag: string): TaskElement;
  /** объявлен ли элемент: разрешается, когда скрипт сети его зарегистрировал */
  defined(tag: string): Promise<void>;
  place(host: HTMLElement, element: TaskElement): void;
  /** следит за высотой элемента; нет наблюдателя размеров — `null`, и готовность сразу */
  watchHeight(element: TaskElement, onHeight: (height: number) => void): (() => void) | null;
}

export interface TaskEnv {
  loader: ScriptLoader;
  dom: TaskDom;
  defineTimeoutMs?: number;
  readyTimeoutMs?: number;
}

export function mountTask(mount: NetworkTaskMount, env: TaskEnv): NetworkTaskHandle {
  let unmounted = false;
  let final = false;
  let ready = false;
  const cleanup: (() => void)[] = [];

  /** Конец — одно слово: после «нет задания» или «выполнено» другие события сети уже ничего не значат. */
  const report = (state: NetworkTaskState): void => {
    if (unmounted || final) return;
    if (state.kind === "ready") {
      if (ready) return;
      ready = true;
    } else {
      final = true;
    }
    mount.onState(state);
  };
  const fail = (reason: AdFailureReason) => report({ kind: "failed", reason });

  const start = async (): Promise<void> => {
    if (mount.network !== "adsgram") return fail("unsupported");
    if (mount.blockId === null) return fail("misconfigured");
    try {
      await env.loader.load(ADSGRAM_SCRIPT);
    } catch {
      return fail("load_failed");
    }
    // Элемент объявляет скрипт сети; не объявил за срок — скрипт не тот или сломан.
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), env.defineTimeoutMs ?? DEFINE_TIMEOUT_MS));
    const defined = env.dom.defined(TASK_TAG).then(
      () => true,
      () => false,
    );
    if (!(await Promise.race([defined, timeout]))) return fail("load_failed");
    if (unmounted) return;

    const element = env.dom.create(TASK_TAG);
    element.setAttribute("data-block-id", mount.blockId);
    element.setAttribute("data-debug", mount.debug === true ? "true" : "false");
    const { look } = mount;
    element.style.setProperty("--adsgram-task-font-size", look.fontSize);
    element.style.setProperty("--adsgram-task-icon-size", look.iconSize);
    element.style.setProperty("--adsgram-task-icon-border-radius", look.iconRadius);
    element.style.setProperty("--adsgram-task-icon-title-gap", look.gap);
    element.style.setProperty("--adsgram-task-button-width", look.buttonWidth);
    for (const [part, slot] of Object.entries(SLOTS) as [NetworkTaskPart, string][]) {
      const node = mount.parts[part];
      node.setAttribute("slot", slot);
      element.append(node);
    }
    const listeners: [string, () => void][] = [
      [EVENTS.reward, () => report({ kind: "done" })],
      [EVENTS.notFound, () => report({ kind: "empty" })],
      [EVENTS.error, () => fail("sdk_error")],
      [EVENTS.stale, () => report({ kind: "stale" })],
    ];
    for (const [type, listener] of listeners) element.addEventListener(type, listener);
    cleanup.push(() => {
      for (const [type, listener] of listeners) element.removeEventListener(type, listener);
      element.remove();
    });

    env.dom.place(mount.host, element);
    const stop = env.dom.watchHeight(element, (height) => {
      if (height > 0) report({ kind: "ready" });
    });
    if (stop === null) {
      report({ kind: "ready" });
      return;
    }
    const timer = setTimeout(() => {
      if (!ready) report({ kind: "empty" });
    }, env.readyTimeoutMs ?? READY_TIMEOUT_MS);
    cleanup.push(() => {
      stop();
      clearTimeout(timer);
    });
  };

  void start();
  return {
    unmount() {
      unmounted = true;
      for (const step of cleanup.splice(0)) step();
    },
  };
}

/** DOM настоящего окна: элемент сети объявляет её скрипт, размер — `ResizeObserver`. */
export function browserTaskDom(): TaskDom {
  return {
    create: (tag) => document.createElement(tag),
    defined: async (tag) => {
      await customElements.whenDefined(tag);
    },
    place: (host, element) => host.append(element as unknown as HTMLElement),
    watchHeight: (element, onHeight) => {
      if (typeof ResizeObserver === "undefined") return null;
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) onHeight(entry.contentRect.height);
      });
      observer.observe(element as unknown as HTMLElement);
      return () => observer.disconnect();
    },
  };
}

/** Задание в настоящем окне — тем же загрузчиком скриптов, что ролики: скрипт AdsGram не вставится дважды. */
export function mountTaskInBrowser(mount: NetworkTaskMount): NetworkTaskHandle {
  return mountTask(mount, { loader: browserScriptLoader(), dom: browserTaskDom() });
}
