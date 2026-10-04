import { imagePath } from "../media/image-rules.js";
import type { ShopView } from "../shop/shop.service.js";
import type { TaskView } from "../tasks/tasks.service.js";
import type { VipView } from "../vip/vip.service.js";
import type { TeamSlideIcon, TeamSlideRow, TeamSlideTarget } from "./team-slide-rules.js";

/**
 * Карусель главной (docs/35-stage4-plan.md WP42, Р76): что показать и в каком
 * порядке, решает сервер — по ценности для игрока, как полосу магазина:
 * идущая акция, новое в версии, пока журнал не открыт, VIP, пока его нет,
 * стартовый набор, пока не куплен, приглашение друзей, канал проекта,
 * партнёрское задание дня. Слайды команды из панели — после акции и нового
 * в версии, а закреплённые командой — первыми: важность анонса знает она.
 *
 * Правило — чистой функцией: его проверяют без базы, а сервис только
 * собирает источники.
 */

/** Больше пяти — карусель превращается в ленту, и до последних слайдов не доходят. */
export const HOME_SLIDES_MAX = 5;

export type HomeSlide =
  | { id: string; kind: "promo"; sku: string; percent: number; endsAt: string; title: string | null }
  | { id: "changelog"; kind: "changelog"; versions: number }
  | { id: "vip"; kind: "vip"; stars: number }
  | { id: "starter"; kind: "starter"; stars: number }
  | { id: "invite"; kind: "invite" }
  | { id: "channel"; kind: "channel"; url: string }
  | { id: string; kind: "task"; taskId: string; taskKind: string; title: string | null; image: string | null; reward: TaskView["reward"] }
  | { id: string; kind: "team"; slideId: string; title: string; text: string; image: string | null; icon: TeamSlideIcon; target: TeamSlideTarget };

export interface HomeSources {
  /** витрина магазина; `null` — не ответил: слайдов акции и стартового набора нет */
  shop: Pick<ShopView, "items"> | null;
  vip: Pick<VipView, "active" | "canOrder" | "stars"> | null;
  /** версии, вышедшие после того, как игрок открывал журнал */
  freshVersions: number;
  /** награды за друзей открыты: под ограничением обещание «награда за каждого» было бы неправдой */
  invite: boolean;
  /** канал проекта из настроек; пусто — слайда нет */
  channelUrl: string;
  /** задания игрока; под ограничением партнёрских — пусто */
  tasks: readonly TaskView[];
  /** слайды команды для этого игрока — уже по площадке и аудитории (`teamSlidesFor`) */
  team: readonly TeamSlideRow[];
}

export function pickSlides(sources: HomeSources, now: Date): HomeSlide[] {
  const slides: HomeSlide[] = sources.team.filter((slide) => slide.pinned).map(teamSlide);
  const items = sources.shop?.items ?? [];
  // Купить можно: на площадке есть способ оплаты, а разовое ещё не куплено.
  const sellable = items.filter((item) => item.stars !== null && !(item.once && item.owned));

  const promo = sellable
    .filter((item) => item.promo !== null && item.promo.endsAt.getTime() > now.getTime())
    .sort((a, b) => (b.promo?.percent ?? 0) - (a.promo?.percent ?? 0) || (a.promo?.endsAt.getTime() ?? 0) - (b.promo?.endsAt.getTime() ?? 0))[0];
  if (promo?.promo != null) {
    slides.push({ id: `promo:${promo.sku}`, kind: "promo", sku: promo.sku, percent: promo.promo.percent, endsAt: promo.promo.endsAt.toISOString(), title: promo.promo.title });
  }

  if (sources.freshVersions > 0) slides.push({ id: "changelog", kind: "changelog", versions: sources.freshVersions });

  slides.push(...sources.team.filter((slide) => !slide.pinned).map(teamSlide));

  const vip = sources.vip;
  if (vip !== null && !vip.active && vip.canOrder && vip.stars !== null) slides.push({ id: "vip", kind: "vip", stars: vip.stars });

  // Стартовый набор по акции уже показан слайдом акции — второй раз не нужен.
  const starter = sellable.find((item) => item.kind === "starter");
  if (starter?.stars != null && starter.sku !== promo?.sku) slides.push({ id: "starter", kind: "starter", stars: starter.stars });

  if (sources.invite) slides.push({ id: "invite", kind: "invite" });
  if (sources.channelUrl !== "") slides.push({ id: "channel", kind: "channel", url: sources.channelUrl });

  const task = partnerTaskOfDay(sources.tasks);
  if (task !== null) {
    slides.push({ id: `task:${task.id}`, kind: "task", taskId: task.id, taskKind: task.kind, title: task.title, image: task.image, reward: task.reward });
  }

  return slides.slice(0, HOME_SLIDES_MAX);
}

function teamSlide(slide: TeamSlideRow): HomeSlide {
  return {
    id: `team:${slide.slideId}`,
    kind: "team",
    slideId: slide.slideId,
    title: slide.title,
    text: slide.text,
    image: slide.imageId === null ? null : imagePath(slide.imageId),
    icon: slide.icon,
    target: slide.target,
  };
}

/**
 * Партнёрское задание дня — первое по порядку каталога, которое игрок ещё
 * не выполнил и на которое есть места: заданием, которое не взять, звать
 * незачем.
 */
export function partnerTaskOfDay(tasks: readonly TaskView[]): TaskView | null {
  return tasks.find((task) => task.category === "partner" && !task.done && !task.claimed && (task.slots === null || task.slots.left > 0)) ?? null;
}
