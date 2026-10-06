import { beforeEach, describe, expect, it } from "vitest";
import { backAction, backKeyAction, hasBackLayers, useBackStack } from "../src/state/back-stack";

// Стек «Назад» (docs/35-stage4-plan.md WP45, Р81): кнопка площадки и Esc
// закрывают верхнюю модалку, а без модалок — делают то, что нужно экрану.

const ESC = { key: "Escape", repeat: false, ctrlKey: false, metaKey: false, altKey: false };

describe("стек «Назад»", () => {
  const calls: string[] = [];
  const pop = (): void => void calls.push("pop");

  beforeEach(() => {
    calls.length = 0;
    useBackStack.setState({ base: { action: null, keyboard: false }, layers: [] });
  });

  it("пустой стек в корне раздела — кнопки нет", () => {
    expect(backAction(useBackStack.getState())).toBeNull();
    expect(hasBackLayers()).toBe(false);
  });

  it("без модалок — действие экрана; модалка сверху перехватывает «Назад», закрытая — отдаёт обратно", () => {
    const stack = useBackStack.getState();
    stack.setBase({ action: pop, keyboard: true });
    expect(backAction(useBackStack.getState())).toBe(pop);

    const id = stack.push(() => calls.push("menu"));
    backAction(useBackStack.getState())?.();
    expect(calls).toEqual(["menu"]);
    expect(hasBackLayers()).toBe(true);

    stack.remove(id);
    backAction(useBackStack.getState())?.();
    expect(calls).toEqual(["menu", "pop"]);
  });

  it("модалка в модалке: «Назад» закрывает верхнюю, снятие из середины порядок не ломает", () => {
    const stack = useBackStack.getState();
    const first = stack.push(() => calls.push("first"));
    const second = stack.push(() => calls.push("second"));
    stack.push(() => calls.push("third"));

    backAction(useBackStack.getState())?.();
    expect(calls).toEqual(["third"]);

    stack.remove(second);
    expect(useBackStack.getState().layers).toHaveLength(2);
    backAction(useBackStack.getState())?.();
    expect(calls).toEqual(["third", "third"]);

    stack.remove(first);
    stack.remove(first);
    expect(useBackStack.getState().layers).toHaveLength(1);
  });

  it("Esc — тот же стек; в забеге клавиши свои, в поле ввода экран не уходит, модалка закрывается", () => {
    const stack = useBackStack.getState();
    stack.setBase({ action: pop, keyboard: true });
    expect(backKeyAction(ESC, useBackStack.getState(), false)).toBe(pop);
    expect(backKeyAction(ESC, useBackStack.getState(), true)).toBeNull();
    expect(backKeyAction({ ...ESC, key: "Enter" }, useBackStack.getState(), false)).toBeNull();
    expect(backKeyAction({ ...ESC, ctrlKey: true }, useBackStack.getState(), false)).toBeNull();
    expect(backKeyAction({ ...ESC, repeat: true }, useBackStack.getState(), false)).toBeNull();

    stack.setBase({ action: () => calls.push("pause"), keyboard: false });
    expect(backKeyAction(ESC, useBackStack.getState(), false)).toBeNull();

    stack.push(() => calls.push("sheet"));
    backKeyAction(ESC, useBackStack.getState(), true)?.();
    expect(calls).toEqual(["sheet"]);
  });
});
