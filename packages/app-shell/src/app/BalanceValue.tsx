import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { countUpValue } from "../screens/count-up-rules";
import { tallyTick } from "../state/ui-feedback";
import { shouldTally, TALLY_DELAY_MS, tallyTicks } from "./balance-tally";

const BUMP_CLASS = "animate-balance-bump";

/**
 * Последнее показанное число каждой валюты — дольше жизни шапки. Награду
 * забирают на экранах без шапки (награда дня, задания, колесо, забег), и
 * шапка монтируется заново, когда игрок вернулся: счёт идёт от того, что он
 * видел перед уходом, а не встаёт сразу.
 */
const lastShown = new Map<string, number>();

/**
 * Баланс в шапке, который набегает после награды (design/art/direction-v2.md
 * §7.6). Разметка сразу несёт итог — его видят диктор и тесты; счёт меняет
 * текст напрямую в кадре анимации, без перерисовок React, как `CountUp`.
 * Значок валюты (`bump`) подпрыгивает, когда счёт начинается: глаз находит,
 * куда легла награда.
 *
 * `null` — кошелёк ещё не пришёл: показывается ноль, а первый ответ сервера
 * встаёт сразу — это загрузка, а не начисление. `id` — чей счёт помнить.
 */
export function BalanceValue(props: { id: string; value: number | null; format: (value: number) => string; bump: RefObject<HTMLElement | null> }): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  const { id, value, format, bump } = props;

  // Только `value`: формат — новая функция на каждой отрисовке шапки.
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null || value === null) return;
    const from = lastShown.get(id) ?? null;
    if (from === null || !shouldTally(from, value) || prefersReducedMotion()) {
      node.textContent = format(value);
      lastShown.set(id, value);
      return;
    }
    const ticks = tallyTicks(from, value);
    let next = 0;
    let frame = 0;
    let start = 0;
    const step = (now: number): void => {
      const elapsed = now - start;
      const current = countUpValue(from, value, elapsed);
      node.textContent = format(current);
      lastShown.set(id, current);
      for (let tick = ticks[next]; tick !== undefined && tick.atMs <= elapsed; tick = ticks[next]) {
        tallyTick(tick.rate);
        next++;
      }
      if (current !== value) frame = requestAnimationFrame(step);
    };
    // Прежнее число — до первой отрисовки: разметка уже несёт итог.
    node.textContent = format(from);
    const timer = setTimeout(() => {
      restartBump(bump.current);
      start = performance.now();
      frame = requestAnimationFrame(step);
    }, TALLY_DELAY_MS);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [value]);

  // Место под итог заранее: пока число короче, плашка не дёргается.
  const final = format(value ?? 0);
  return (
    <span ref={ref} className="inline-block" style={{ minWidth: `${String(final.length)}ch` }}>
      {final}
    </span>
  );
}

/** Анимация с начала: снять класс, дать браузеру заметить и вернуть. */
function restartBump(node: HTMLElement | null): void {
  if (node === null) return;
  node.classList.remove(BUMP_CLASS);
  void node.offsetWidth;
  node.classList.add(BUMP_CLASS);
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
