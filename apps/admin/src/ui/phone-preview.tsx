import { useEffect, useRef, useState } from "react";
import { PREVIEW_HEIGHTS, PREVIEW_URL, PREVIEW_WIDTHS, draftMessage, isReady, previewOrigin, type PreviewKind, type PreviewWidth } from "../api/preview";
import { Notice } from "./kit";

/** Сколько ждать «готова» от страницы, прежде чем сказать, что она не отвечает. */
const READY_TIMEOUT_MS = 6_000;

type Orientation = "portrait" | "landscape";

/**
 * Предпросмотр тем же компонентом, что у игрока (docs/35-stage4-plan.md WP32,
 * Р83): страница клиента в рамке телефона, черновик уходит в неё на каждое
 * изменение формы. Ширина и ориентация переключаются — длинный заголовок,
 * который влез на 430, на 320 обрежется, и это видно до сохранения.
 *
 * `height` — сколько экрана показать: слайду главной хватает верха, весь
 * телефон был бы пустым фоном.
 */
export function PhonePreview({ kind, draft, height, caption }: { kind: PreviewKind; draft: unknown; height: number; caption: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState<PreviewWidth>(390);
  const [orientation, setOrientation] = useState<Orientation>("portrait");
  const [state, setState] = useState<"waiting" | "ready" | "silent">("waiting");
  const origin = previewOrigin();
  const shownWidth = orientation === "portrait" ? width : PREVIEW_HEIGHTS[width];

  useEffect(() => {
    if (origin === null) return;
    const onMessage = (event: MessageEvent): void => {
      if (event.source === frame.current?.contentWindow && isReady(event, origin)) setState("ready");
    };
    window.addEventListener("message", onMessage);
    const timer = setTimeout(() => setState((current) => (current === "ready" ? current : "silent")), READY_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
  }, [origin]);

  // Черновик — в ответ на «готова» и на каждое изменение: до загрузки страницы его некому принять.
  const serialized = JSON.stringify(draft);
  useEffect(() => {
    if (state !== "ready" || origin === null) return;
    frame.current?.contentWindow?.postMessage(draftMessage(kind, JSON.parse(serialized)), origin);
  }, [state, origin, kind, serialized]);

  if (origin === null) {
    return <Notice tone="info">Предпросмотр не настроен: панели нужен адрес страницы предпросмотра клиента — VITE_PREVIEW_URL (docs/20-env-and-ports.md).</Notice>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <span>{caption}</span>
        <span className="flex gap-1" role="group" aria-label="Ширина телефона">
          {PREVIEW_WIDTHS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={candidate === width}
              onClick={() => setWidth(candidate)}
              className={`rounded-sm border px-1.5 py-0.5 tabular-nums ${candidate === width ? "border-accent text-text" : "border-border hover:border-border-strong"}`}
            >
              {candidate}
            </button>
          ))}
        </span>
        <span className="flex gap-1" role="group" aria-label="Ориентация">
          {(["portrait", "landscape"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={candidate === orientation}
              onClick={() => setOrientation(candidate)}
              className={`rounded-sm border px-1.5 py-0.5 ${candidate === orientation ? "border-accent text-text" : "border-border hover:border-border-strong"}`}
            >
              {candidate === "portrait" ? "портрет" : "ландшафт"}
            </button>
          ))}
        </span>
      </div>
      <div className="overflow-x-auto">
        {/* Рамка — как экран телефона: скруглённые углы и чёрный кант, внутри — ровно та ширина, что у игрока. */}
        <div className="inline-block rounded-[20px] border-4 border-black bg-black shadow-card">
          <iframe
            ref={frame}
            title="Предпросмотр"
            src={PREVIEW_URL}
            width={shownWidth}
            height={height}
            // Скрипты нужны странице, свой источник — чтобы панель узнала её по адресу; остальное закрыто.
            sandbox="allow-scripts allow-same-origin"
            className="block rounded-[16px]"
          />
        </div>
      </div>
      {orientation === "landscape" ? <span className="text-xs text-text-muted">В ландшафте телефона карусели нет — так она выглядит на планшете и в широком окне.</span> : null}
      {state === "silent" ? (
        <Notice tone="warning">Страница предпросмотра не отвечает: клиент не запущен по адресу {PREVIEW_URL} или не знает адрес панели — VITE_ADMIN_URL (docs/20-env-and-ports.md).</Notice>
      ) : null}
    </div>
  );
}
