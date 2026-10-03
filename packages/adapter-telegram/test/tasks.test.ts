import type { NetworkTaskMount, NetworkTaskPart, NetworkTaskState } from "@bh/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADSGRAM_SCRIPT } from "../src/ads/networks";
import { mountTask, READY_TIMEOUT_MS, type TaskDom, type TaskElement } from "../src/ads/tasks";

/**
 * Задание AdsGram в строке оболочки (docs/35-stage4-plan.md WP13, часть 6)
 * на поддельном DOM: наши узлы — в слоты сети, вид — в её CSS-переменные,
 * события элемента — в состояния порта, одно последнее слово; снятая строка
 * не оставляет ни элемента, ни слушателей.
 */

class FakeElement extends EventTarget implements TaskElement {
  readonly attributes = new Map<string, string>();
  readonly properties = new Map<string, string>();
  readonly children: FakeNode[] = [];
  removed = false;
  readonly style = { setProperty: (name: string, value: string) => void this.properties.set(name, value) };

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...nodes: HTMLElement[]): void {
    this.children.push(...(nodes as unknown as FakeNode[]));
  }

  remove(): void {
    this.removed = true;
  }

  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

class FakeNode {
  readonly attributes = new Map<string, string>();
  constructor(readonly part: NetworkTaskPart) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

function fakeDom(options: { defined?: boolean; observer?: boolean } = {}) {
  const created: FakeElement[] = [];
  const placed: FakeElement[] = [];
  let height: ((value: number) => void) | null = null;
  const dom: TaskDom = {
    create: () => {
      const element = new FakeElement();
      created.push(element);
      return element;
    },
    defined: () => (options.defined === false ? new Promise<void>(() => undefined) : Promise.resolve()),
    place: (_host, element) => void placed.push(element as FakeElement),
    watchHeight: (_element, onHeight) => {
      if (options.observer === false) return null;
      height = onHeight;
      return () => {
        height = null;
      };
    },
  };
  return { dom, created, placed, resize: (value: number) => height?.(value), watching: () => height !== null };
}

function mountOf(patch: Partial<NetworkTaskMount> = {}) {
  const states: NetworkTaskState[] = [];
  const parts = { reward: new FakeNode("reward"), open: new FakeNode("open"), claim: new FakeNode("claim"), done: new FakeNode("done") };
  const mount: NetworkTaskMount = {
    network: "adsgram",
    blockId: "task-123",
    host: {} as HTMLElement,
    parts: parts as unknown as NetworkTaskMount["parts"],
    look: { fontSize: "14px", iconSize: "44px", iconRadius: "var(--radius-md)", gap: "12px", buttonWidth: "96px" },
    onState: (state) => void states.push(state),
    ...patch,
  };
  return { mount, states, parts };
}

const loaderOf = (fail = false) => {
  const loaded: string[] = [];
  return {
    loaded,
    loader: {
      load: async (src: string) => {
        loaded.push(src);
        if (fail) throw new Error("нет сети");
      },
    },
  };
};

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("задание AdsGram в строке оболочки", () => {
  it("скрипт AdsGram, элемент с блоком и тестовым режимом, наши узлы — в слоты сети, вид — в её переменные", async () => {
    const { dom, created, placed } = fakeDom();
    const { loader, loaded } = loaderOf();
    const { mount, parts } = mountOf({ debug: true });
    mountTask(mount, { loader, dom });
    await settle();
    expect(loaded).toEqual([ADSGRAM_SCRIPT]);
    const [element] = created;
    expect(placed).toEqual([element]);
    expect(Object.fromEntries(element?.attributes ?? [])).toEqual({ "data-block-id": "task-123", "data-debug": "true" });
    expect(Object.fromEntries(element?.properties ?? [])).toEqual({
      "--adsgram-task-font-size": "14px",
      "--adsgram-task-icon-size": "44px",
      "--adsgram-task-icon-border-radius": "var(--radius-md)",
      "--adsgram-task-icon-title-gap": "12px",
      "--adsgram-task-button-width": "96px",
    });
    expect(element?.children.map((node) => [node.part, node.attributes.get("slot")])).toEqual([
      ["reward", "reward"],
      ["open", "button"],
      ["claim", "claim"],
      ["done", "done"],
    ]);
    expect(parts.open.attributes.get("slot")).toBe("button");
  });

  it("на экране — с первым ненулевым размером; выполнено — событием reward, и дальше сеть уже ничего не меняет", async () => {
    const { dom, created, resize } = fakeDom();
    const { mount, states } = mountOf();
    mountTask(mount, { loader: loaderOf().loader, dom });
    await settle();
    resize(0);
    expect(states).toEqual([]);
    resize(64);
    resize(70);
    created[0]?.fire("reward");
    created[0]?.fire("onError");
    expect(states).toEqual([{ kind: "ready" }, { kind: "done" }]);
  });

  it("нет задания, ошибка сети, приложение открыто слишком долго — свои слова", async () => {
    for (const [event, state] of [
      ["onBannerNotFound", { kind: "empty" }],
      ["onError", { kind: "failed", reason: "sdk_error" }],
      ["onTooLongSession", { kind: "stale" }],
    ] as const) {
      const { dom, created } = fakeDom();
      const { mount, states } = mountOf();
      mountTask(mount, { loader: loaderOf().loader, dom });
      await settle();
      created[0]?.fire(event);
      expect(states, event).toEqual([state]);
    }
  });

  it("задание так и не нарисовалось — значит, его нет", async () => {
    vi.useFakeTimers();
    const { dom } = fakeDom();
    const { mount, states } = mountOf();
    mountTask(mount, { loader: loaderOf().loader, dom });
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 1);
    expect(states).toEqual([{ kind: "empty" }]);
  });

  it("без наблюдателя размеров — на экране сразу; незнакомая сеть, нет блока, скрипт не загрузился, элемент не объявлен — отказы", async () => {
    const plain = fakeDom({ observer: false });
    const ready = mountOf();
    mountTask(ready.mount, { loader: loaderOf().loader, dom: plain.dom });
    await settle();
    expect(ready.states).toEqual([{ kind: "ready" }]);

    const cases: [Partial<NetworkTaskMount>, boolean, boolean, NetworkTaskState][] = [
      [{ network: "taddy" }, false, true, { kind: "failed", reason: "unsupported" }],
      [{ blockId: null }, false, true, { kind: "failed", reason: "misconfigured" }],
      [{}, true, true, { kind: "failed", reason: "load_failed" }],
      [{}, false, false, { kind: "failed", reason: "load_failed" }],
    ];
    for (const [patch, scriptFails, defined, expected] of cases) {
      const { dom, created } = fakeDom({ defined });
      const { mount, states } = mountOf(patch);
      mountTask(mount, { loader: loaderOf(scriptFails).loader, dom, defineTimeoutMs: 5 });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(states).toEqual([expected]);
      expect(created).toEqual([]);
    }
  });

  it("снятая строка: элемент убран, слушатели сняты, наблюдатель остановлен; снятая до загрузки — элемент не встаёт", async () => {
    const { dom, created, watching } = fakeDom();
    const { mount, states } = mountOf();
    const handle = mountTask(mount, { loader: loaderOf().loader, dom });
    await settle();
    handle.unmount();
    expect(created[0]?.removed).toBe(true);
    expect(watching()).toBe(false);
    created[0]?.fire("reward");
    expect(states).toEqual([]);

    const early = fakeDom();
    const second = mountOf();
    mountTask(second.mount, { loader: loaderOf().loader, dom: early.dom }).unmount();
    await settle();
    expect(early.created).toEqual([]);
    expect(second.states).toEqual([]);
  });
});
