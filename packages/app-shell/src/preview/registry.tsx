import type { ReactNode } from "react";
import { t } from "../i18n";
import "../i18n/home";
import "../i18n/preview";
import { slideImageUrl, type HomeSlide } from "../state/home-api";
import { SlideDots, SlideView, STRIP_CLASS } from "../screens/home-slide";
import { homeSlideDraftSchema, type PreviewKind } from "./protocol";

/**
 * Реестр предпросмотра: вид черновика → схема и отрисовка тем же
 * компонентом, что у игрока. Сети и входа здесь нет — черновик целиком
 * приходит из панели, картинка — по адресу медиа API.
 */

export interface PreviewContext {
  /** адрес API: картинки из панели лежат там */
  apiBaseUrl: string;
}

interface PreviewEntry {
  render(draft: unknown, context: PreviewContext): ReactNode | null;
}

/** Сосед справа — обычный слайд по правилу: край следующего слайда у игрока виден всегда. */
const NEIGHBOUR: HomeSlide = { id: "invite", kind: "invite" };

const noop = (): void => undefined;

function HomeSlidePreview(props: { slide: HomeSlide; apiBaseUrl: string }): ReactNode {
  const now = Date.now();
  const image = props.slide.kind === "team" ? slideImageUrl(props.slide.image, props.apiBaseUrl) : null;
  return (
    <section className="min-w-0" aria-label={t("home.carousel")}>
      <div className={`${STRIP_CLASS} overflow-hidden`}>
        <SlideView slide={props.slide} now={now} image={image} wide={false} onOpen={noop} />
        <SlideView slide={NEIGHBOUR} now={now} image={null} wide={false} onOpen={noop} />
      </div>
      <SlideDots ids={[props.slide.id, NEIGHBOUR.id]} current={0} onSelect={noop} />
    </section>
  );
}

export const PREVIEW_REGISTRY: Record<PreviewKind, PreviewEntry> = {
  "home-slide": {
    render(draft, context) {
      const parsed = homeSlideDraftSchema.safeParse(draft);
      if (!parsed.success) return null;
      const { title, text, imageId, icon } = parsed.data;
      // Пустое поле — подписью-заготовкой: пустой слайд в рамке выглядит поломкой, а не черновиком.
      const slide: HomeSlide = {
        id: "team:preview",
        kind: "team",
        slideId: "preview",
        title: title.trim() === "" ? t("preview.slide.title") : title,
        text: text.trim() === "" ? t("preview.slide.text") : text,
        image: imageId === null ? null : `/api/v1/media/${imageId}.webp`,
        icon,
        target: { kind: "screen", screen: "shop" },
      };
      return <HomeSlidePreview slide={slide} apiBaseUrl={context.apiBaseUrl} />;
    },
  },
};
