import type { ReactNode } from "react";
import { t } from "../i18n";
import "../i18n/home";
import "../i18n/preview";
import type { ChangelogVersion } from "../state/changelog-api";
import { slideImageUrl, type HomeSlide } from "../state/home-api";
import { taskImageUrl, type TaskItem } from "../state/tasks-api";
import { SlideDots, SlideView, STRIP_CLASS } from "../screens/home-slide";
import { VersionCard } from "../screens/meta/changelog-card";
import { TaskRow } from "../screens/meta/task-row";
import { changelogDraftSchema, homeSlideDraftSchema, taskDraftSchema, type ChangelogDraft, type PreviewKind, type TaskDraft } from "./protocol";

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

/**
 * Версия журнала — карточкой «Что нового», новой и вышедшей сегодня: так её
 * увидит игрок в день публикации. Пустая версия — заготовкой, а не пустой
 * карточкой, которая выглядела бы поломкой.
 */
export function changelogVersion(draft: ChangelogDraft, now: Date): ChangelogVersion {
  const entries = draft.entries.filter((entry) => entry.text.trim() !== "").map((entry, index) => ({ id: String(index), kind: entry.kind, text: entry.text.trim() }));
  return {
    version: draft.version.trim() === "" ? t("preview.changelog.version") : draft.version.trim(),
    publishedAt: now.toISOString(),
    fresh: true,
    entries: entries.length > 0 ? entries : [{ id: "0", kind: "added", text: t("preview.changelog.entry") }],
  };
}

/**
 * Задание — двумя строками: какой его видит игрок до выполнения и какой —
 * готовым к забору. Прогресс до выполнения — нулевой, как у нового задания;
 * заголовок пустой — по виду цели, как у игрока.
 */
export function taskStates(draft: TaskDraft): { before: TaskItem; after: TaskItem } {
  const title = draft.title === null || draft.title.trim() === "" ? null : draft.title.trim();
  const base: TaskItem = {
    id: "preview",
    period: draft.period,
    category: draft.partner ? "partner" : draft.period,
    kind: draft.kind,
    title,
    target: draft.target,
    value: 0,
    done: false,
    claimed: false,
    reward: draft.reward,
    passPoints: 0,
    link: draft.link,
    slots: null,
    image: draft.imageId === null ? null : `/api/v1/media/${draft.imageId}.webp`,
  };
  return { before: base, after: { ...base, value: draft.target, done: true } };
}

function TaskPreview(props: { draft: TaskDraft; apiBaseUrl: string }): ReactNode {
  const { before, after } = taskStates(props.draft);
  const image = taskImageUrl(before.image, props.apiBaseUrl);
  const row = (task: TaskItem, index: number): ReactNode => (
    <TaskRow index={index} task={task} image={image} claiming={false} notice={null} closed={false} onClaim={noop} onOpen={noop} />
  );
  return (
    <div className="grid gap-2">
      <p className="text-xs font-semibold text-text-muted">{t("preview.task.before")}</p>
      {row(before, 0)}
      <p className="mt-2 text-xs font-semibold text-text-muted">{t("preview.task.after")}</p>
      {row(after, 1)}
    </div>
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
  "changelog-version": {
    render(draft) {
      const parsed = changelogDraftSchema.safeParse(draft);
      return parsed.success ? <VersionCard version={changelogVersion(parsed.data, new Date())} index={0} /> : null;
    },
  },
  task: {
    render(draft, context) {
      const parsed = taskDraftSchema.safeParse(draft);
      return parsed.success ? <TaskPreview draft={parsed.data} apiBaseUrl={context.apiBaseUrl} /> : null;
    },
  },
};
