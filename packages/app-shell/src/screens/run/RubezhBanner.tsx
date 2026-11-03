import { useEffect, useRef, useState, type ReactNode } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { t } from "../../i18n";
import "../../i18n/run";
import type { RubezhNotice } from "../../state/run";

/**
 * Баннеры рубежа (tasks/T-0124, Р102): «Страж рубежа пришёл» и «Рубеж взят!
 * Бой продолжается». Самостоятельный компонент: ему нужно только сообщение
 * (`RubezhNotice`), поэтому пролог (T-0280) показывает его тем же способом, не
 * трогая стор боя.
 *
 * Правила боя (docs/27-design-system-and-app-shell.md §3.3):
 * - состояние меняется по сообщению, а не по кадру: на одно сообщение две
 *   перерисовки — появление и уход, поэтому до десяти в секунду далеко;
 * - анимируются только `transform` и `opacity`, цвета — токены, отступы от
 *   выреза и кнопок Telegram — `--app-inset-*`;
 * - слой не ловит касания: под ним джойстик;
 * - баннер обязателен для чтения боя и под переключатель настроек не попадает
 *   («Настройки не отстают от игры»): страж без объявления — это не эффект,
 *   а потерянная информация.
 */

/** Сколько баннер на экране, мс: три-четыре секунды, чтобы прочитать, пока не мешает бою. */
export const BANNER_MS = 3500;

/** Сколько из этого времени занимает уход прозрачностью, мс. */
export const BANNER_FADE_MS = 300;

export type BannerPhase = "in" | "out";

/** Что показано сейчас: сообщение и фаза — появление и стояние или уход. */
export interface ShownBanner {
  notice: RubezhNotice;
  phase: BannerPhase;
}

/**
 * Номер последнего показанного сообщения. Живёт вне компонента: размонтированный
 * и смонтированный заново баннер (экран пересобрался, например после второго
 * шанса) не повторяет то, что уже было показано. Номера сообщений общие на
 * сессию и не повторяются, поэтому чужое сообщение за показанное не сойдёт.
 */
export interface BannerMemory {
  seq: number | null;
}

export interface BannerTimeline {
  /** Показать сообщение; то же (по номеру) ничего не меняет, `null` убирает баннер сразу. */
  show(notice: RubezhNotice | null): void;
  /** Снять таймеры: экран разобран, перерисовывать нечего. */
  dispose(): void;
}

/**
 * Время жизни баннера без React: таймеры и номер показанного сообщения.
 * Новое сообщение снимает таймеры старого и показывается целиком — тексты двух
 * подряд не склеиваются и не гасят друг друга.
 */
export function createBannerTimeline(
  onChange: (shown: ShownBanner | null) => void,
  memory: BannerMemory = { seq: null },
): BannerTimeline {
  let timers: ReturnType<typeof setTimeout>[] = [];

  const clear = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };

  return {
    show(notice): void {
      if (notice === null) {
        clear();
        // Сообщения нет вовсе — новый забег: то же сообщение с тем же номером
        // после этого снова новое.
        if (memory.seq !== null) onChange(null);
        memory.seq = null;
        return;
      }
      if (notice.seq === memory.seq) return;
      memory.seq = notice.seq;
      clear();
      onChange({ notice, phase: "in" });
      timers.push(setTimeout(() => onChange({ notice, phase: "out" }), BANNER_MS - BANNER_FADE_MS));
      timers.push(setTimeout(() => onChange(null), BANNER_MS));
    },
    // Память не трогаем: следующий баннер продолжит с того же места.
    dispose(): void {
      clear();
    },
  };
}

/** Память баннера экрана боя: одна на сессию, переживает размонтирование. */
const screenMemory: BannerMemory = { seq: null };

export function RubezhBanner(props: { notice: RubezhNotice | null }): ReactNode {
  const [shown, setShown] = useState<ShownBanner | null>(null);
  const timeline = useRef<BannerTimeline | null>(null);

  useEffect(() => {
    const created = createBannerTimeline(setShown, screenMemory);
    timeline.current = created;
    return () => {
      created.dispose();
      timeline.current = null;
    };
  }, []);

  useEffect(() => {
    timeline.current?.show(props.notice);
  }, [props.notice]);

  return <RubezhBannerView shown={shown} />;
}

/** Только рисование: что показано — решает `createBannerTimeline`. */
export function RubezhBannerView(props: { shown: ShownBanner | null }): ReactNode {
  const { shown } = props;
  if (shown === null) return null;
  const spawned = shown.notice.kind === "spawned";
  const Icon = spawned ? ShieldAlert : ShieldCheck;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex justify-center pr-[calc(1rem+var(--app-inset-right))] pl-[calc(1rem+var(--app-inset-left))]"
      style={{ zIndex: "var(--z-hud)", top: "calc(30% + var(--app-inset-top))" }}
    >
      {/* Ключ — номер сообщения: следующее сообщение собирает плашку заново, и вход проигрывается снова. */}
      <div
        key={shown.notice.seq}
        role="status"
        className={[
          "surface-panel flex max-w-[360px] items-center gap-3 rounded-lg border px-4 py-3",
          spawned ? "border-elite/60" : "border-accent/60",
          shown.phase === "out" ? "opacity-0" : "animate-rise-in",
          "transition-opacity duration-300 ease-out",
        ].join(" ")}
      >
        <span
          className={[
            "inline-flex size-9 shrink-0 items-center justify-center rounded-md",
            spawned ? "bg-elite/15 text-elite" : "bg-accent/15 text-accent",
          ].join(" ")}
        >
          <Icon size={20} aria-hidden="true" />
        </span>
        <span className="font-display text-sm font-bold text-text">
          {t(spawned ? "run.rubezh.banner.spawned" : "run.rubezh.banner.cleared")}
        </span>
      </div>
    </div>
  );
}
