import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { X } from "lucide-react";
import type { AdCreative } from "@bh/shared-types";
import { Button, IconButton } from "../design-system/components";
import { t } from "../i18n";
import "../i18n/ads";
import { useBackLayer } from "../state/back-stack";
import { openExternalLink } from "../state/external-link";

/**
 * Наш рекламный блок (docs/35-stage4-plan.md WP12, часть 9, Р78): объявление
 * сети с API — Taddy — рисует игра, в своём стиле и токенами, а не SDK сети.
 * Блок общий для любой рекламы с креативом: тем же видом пойдёт и своя
 * прямая реклама (§1.2).
 *
 * Досмотр — отсчёт на экране: за награду — пока не дойдёт до конца, без
 * награды — закрыть можно после короткого отсчёта. Клик досмотр не
 * ускоряет: награда за клик — это мотивированный трафик, его сети не
 * засчитывают. Отсчёт — по часам, а не по тикам: игрок ушёл по ссылке,
 * вернулся — время шло.
 *
 * Полоса отсчёта — `scaleX`, а не кольцо: блок встаёт и поверх
 * остановленного забега, а анимировать можно только `transform` и
 * `opacity` (docs/27-design-system-and-app-shell.md §3.3).
 */

export interface CreativeShow {
  ad: AdCreative;
  /** через сколько секунд на экране показ досмотрен */
  viewSec: number;
  /** за награду: закрыть раньше — значит уйти без неё */
  rewarded: boolean;
}

/** Чем кончился показ: досмотрен, закрыт раньше, не показан — картинка не загрузилась. */
export type CreativeResult = { kind: "completed" } | { kind: "closed" } | { kind: "failed"; reason: "load_failed" };

export interface CreativeHooks {
  /** блок на экране — сервер сообщает сети показ */
  onShown(): void;
  /** игрок открыл объявление — ссылка уже открыта в том же касании */
  onClick(): void;
  /** открыть ссылку объявления в том же касании; по умолчанию — адаптером площадки (`state/external-link.ts`) */
  openLink?(url: string): void;
  now?(): number;
}

/** Сколько ждём картинку объявления: дольше — показа не будет, выдача уйдёт к следующей сети. */
export const IMAGE_TIMEOUT_MS = 4_000;
/** Затухание блока на закрытии — короче, чем ждут глазами. */
const CLOSE_FADE_MS = 150;

/** Загрузить картинку заранее: блок не появляется пустой рамкой и отсчёт не идёт по пустому месту. */
export function preloadImage(url: string, timeoutMs = IMAGE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => resolve(false), timeoutMs);
    image.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    image.src = url;
  });
}

/**
 * Что показать после загрузки картинок: картинка не пришла — без неё, если
 * есть заголовок; без заголовка и картинки показывать нечего.
 */
export async function readyCreative(ad: AdCreative, preload: (url: string) => Promise<boolean> = preloadImage): Promise<AdCreative | null> {
  const [image, icon] = await Promise.all([ad.image === null ? false : preload(ad.image), ad.icon === null ? false : preload(ad.icon)]);
  const ready = { ...ad, image: image ? ad.image : null, icon: icon ? ad.icon : null };
  return ready.image === null && ready.title === null ? null : ready;
}

/**
 * Показать креатив поверх всего приложения. Свой корень React: блок
 * открывается из потока показа, а не из экрана, и встаёт над любым
 * экраном и забегом; стили и токены — общие, стек «Назад» — тоже.
 */
export async function showCreative(show: CreativeShow, hooks: CreativeHooks): Promise<CreativeResult> {
  const ad = await readyCreative(show.ad);
  if (ad === null) return { kind: "failed", reason: "load_failed" };
  return await new Promise<CreativeResult>((resolve) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const finish = (result: CreativeResult): void => {
      // Корень снимается после события, а не внутри него: React не размонтирует себя посреди обработчика.
      setTimeout(() => {
        root.unmount();
        host.remove();
        resolve(result);
      }, 0);
    };
    root.render(<AdCreativeBlock show={{ ...show, ad }} hooks={hooks} onDone={finish} />);
  });
}

/** Сколько секунд осталось до досмотра — целыми, вверх: «1 с» до самого конца. */
export function secondsLeft(startedAt: number, viewSec: number, now: number): number {
  return Math.max(0, Math.ceil(viewSec - (now - startedAt) / 1000));
}

export function AdCreativeBlock(props: { show: CreativeShow; hooks: CreativeHooks; onDone: (result: CreativeResult) => void }): ReactNode {
  const { show, hooks } = props;
  const now = hooks.now ?? Date.now;
  const [startedAt] = useState(now);
  const [left, setLeft] = useState(show.viewSec);
  const [closing, setClosing] = useState(false);
  const finished = useRef(false);
  const clicked = useRef(false);
  const viewed = left === 0;

  // Показ сообщается однажды — при появлении блока, а не на каждую отрисовку.
  const shown = useRef(hooks.onShown);
  useEffect(() => {
    shown.current();
  }, []);

  // Секунды — раз в четверть секунды по часам: число в углу меняется ровно
  // раз в секунду, а вернувшийся из браузера игрок сразу видит, сколько осталось.
  useEffect(() => {
    if (viewed) return;
    const timer = setInterval(() => setLeft(secondsLeft(startedAt, show.viewSec, now())), 250);
    return () => clearInterval(timer);
  }, [viewed, startedAt, show.viewSec, now]);

  const close = (): void => {
    if (finished.current) return;
    finished.current = true;
    setClosing(true);
    const result: CreativeResult = secondsLeft(startedAt, show.viewSec, now()) === 0 ? { kind: "completed" } : { kind: "closed" };
    setTimeout(() => props.onDone(result), CLOSE_FADE_MS);
  };

  // «Назад» площадки и Esc закрывают блок, как любую модалку (WP45): до
  // конца отсчёта за награду — без неё.
  useBackLayer(close);

  const open = (): void => {
    (hooks.openLink ?? openExternalLink)(show.ad.link);
    if (clicked.current) return;
    clicked.current = true;
    hooks.onClick();
  };

  const { ad } = show;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("ads.label", { advertiser: ad.advertiser })}
      className={[
        "fixed inset-0 flex flex-col bg-bg",
        "pt-[var(--app-inset-top)] pr-[var(--app-inset-right)] pb-[var(--app-inset-bottom)] pl-[var(--app-inset-left)]",
        "transition-opacity duration-(--duration-fast) ease-base",
        closing ? "opacity-0" : "animate-fade-in",
      ].join(" ")}
      style={{ zIndex: "calc(var(--z-modal) + 5)" }}
    >
      {/* Полоса отсчёта: одна CSS-анимация по `scaleX` на весь срок, без перерисовок React. */}
      <div aria-hidden="true" className="h-1 w-full shrink-0 overflow-hidden bg-surface-sunken">
        {viewed ? null : (
          <div
            className="h-full w-full origin-left animate-ad-countdown bg-accent"
            style={{ animationDuration: `${String(show.viewSec)}s`, animationDelay: `${String(-(now() - startedAt) / 1000)}s` }}
          />
        )}
      </div>

      <header className="flex shrink-0 items-center gap-2 px-4 py-2">
        <span className="min-w-0 flex-1 truncate rounded-full bg-surface-raised px-3 py-1 text-xs font-semibold text-text-muted">
          {t("ads.label", { advertiser: ad.advertiser })}
        </span>
        {viewed ? (
          <IconButton label={t("ads.close")} feedback="back" onClick={close}>
            <X size={22} />
          </IconButton>
        ) : (
          <span
            aria-live="polite"
            aria-label={show.rewarded ? t("ads.rewardIn", { seconds: left }) : t("ads.closeIn", { seconds: left })}
            className="inline-flex size-11 items-center justify-center rounded-full bg-surface-raised font-display text-base font-bold text-text tabular-nums"
          >
            {left}
          </span>
        )}
      </header>

      {/* `m-auto`, а не центрирование флексом: карточка выше экрана (ландшафт,
          маленький телефон) прокручивается целиком, а не обрезается сверху. */}
      <main className="flex min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2">
        <article className="surface-panel m-auto flex w-full max-w-[420px] flex-col overflow-hidden rounded-xl animate-pop-in landscape:max-w-[760px] landscape:flex-row">
          {ad.image === null ? null : (
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              onClick={open}
              className="flex aspect-square max-h-[42vh] w-full items-center justify-center overflow-hidden bg-surface-sunken landscape:aspect-auto landscape:h-[min(60vh,18rem)] landscape:max-h-none landscape:w-2/5"
            >
              <img src={ad.image} alt="" className="max-h-full max-w-full object-contain" />
            </button>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-5 short:p-4 landscape:justify-center landscape:p-4">
            <div className="flex items-start gap-3">
              {ad.icon === null ? null : <img src={ad.icon} alt="" className="size-12 shrink-0 rounded-md bg-surface-sunken object-cover" />}
              {ad.title === null ? null : <h2 className="line-clamp-2 min-w-0 font-display text-xl font-bold text-text landscape:text-lg">{ad.title}</h2>}
            </div>
            {bodyOf(ad) === null ? null : <p className="line-clamp-4 text-sm text-text-muted">{bodyOf(ad)}</p>}
            <Button block onClick={open}>
              {ad.button ?? t("ads.open")}
            </Button>
          </div>
        </article>
      </main>

      {show.rewarded ? (
        <footer className="flex shrink-0 flex-col items-center gap-1 px-4 pt-1 pb-3 text-center landscape:flex-row landscape:justify-center landscape:gap-4 landscape:pb-1">
          <p aria-hidden="true" className="text-sm font-semibold text-text-muted">
            {viewed ? t("ads.rewardReady") : t("ads.rewardIn", { seconds: left })}
          </p>
          {/* Кнопка остаётся местом и после отсчёта — невидимой: карточка не прыгает, когда награда готова. */}
          <button
            type="button"
            onClick={close}
            disabled={viewed}
            aria-hidden={viewed}
            className={["min-h-11 px-3 text-xs text-text-muted underline-offset-2 active:underline", viewed ? "invisible" : ""].join(" ")}
          >
            {t("ads.closeEarly")}
          </button>
        </footer>
      ) : null}
    </div>
  );
}

/** Текст объявления: описание, иначе текст — сеть кладёт его то в одно поле, то в другое. */
function bodyOf(ad: AdCreative): string | null {
  return ad.description ?? ad.text;
}

/**
 * Тот же креатив карточкой в строку — для ленты главной и заданий: пометка
 * «Реклама», значок, заголовок, текст и кнопка. Отсчёта нет: карточку
 * листают, а не смотрят.
 */
export function AdCreativeCard(props: { ad: AdCreative; onOpen: () => void }): ReactNode {
  const { ad } = props;
  return (
    <article className="surface-panel flex items-center gap-3 rounded-lg p-3">
      {(ad.icon ?? ad.image) === null ? null : <img src={ad.icon ?? ad.image ?? ""} alt="" className="size-14 shrink-0 rounded-md bg-surface-sunken object-cover" />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-semibold tracking-wide text-text-muted uppercase">{t("ads.label", { advertiser: ad.advertiser })}</p>
        {ad.title === null ? null : <h3 className="truncate font-display text-base font-bold text-text">{ad.title}</h3>}
        {bodyOf(ad) === null ? null : <p className="line-clamp-2 text-xs text-text-muted">{bodyOf(ad)}</p>}
      </div>
      <Button variant="secondary" onClick={props.onOpen}>
        {ad.button ?? t("ads.open")}
      </Button>
    </article>
  );
}
