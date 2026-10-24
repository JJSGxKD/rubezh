import { useLayoutEffect, useRef, type ReactNode } from "react";
import { countUpValue } from "./count-up-rules";

/**
 * Набегающее число награды. Разметка сразу несёт итог — его видят диктор,
 * тесты и игрок с «меньше движения»; анимация меняет текст напрямую в кадре
 * анимации, без перерисовок React. Новое значение (удвоение за рекламу)
 * досчитывается от показанного, а не с нуля.
 */
export function CountUp(props: { value: number; format: (value: number) => string }): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const { value, format } = props;

  // Только `value`: формат — новая функция на каждой отрисовке, и с ним в
  // зависимостях счёт перезапускался бы с каждым кадром родителя.
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const from = shown.current ?? 0;
    if (from === value || prefersReducedMotion()) {
      node.textContent = format(value);
      shown.current = value;
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number): void => {
      const current = countUpValue(from, value, now - start);
      node.textContent = format(current);
      shown.current = current;
      if (current !== value) frame = requestAnimationFrame(step);
    };
    node.textContent = format(from);
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  // Место под итог заранее: пока число короче, соседние подписи не ездят.
  const final = format(value);
  return (
    <span ref={ref} className="inline-block" style={{ minWidth: `${String(final.length)}ch` }}>
      {final}
    </span>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
