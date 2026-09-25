import { Component, lazy, type ComponentType, type ReactNode } from "react";
import { ErrorState } from "../design-system/components";
import { t } from "../i18n";
import { reportError } from "../state/shell";

/**
 * Экраны, которые грузятся по требованию (docs/27-design-system-and-app-shell.md
 * §3.4). В первую загрузку идёт только путь до «Играть»: заставки, лобби,
 * выбор режима и оружия. Сам забег — HUD, пауза, выбор улучшения — чанком,
 * который лобби подтягивает в простое вместе с движком: без движка он всё
 * равно не начнётся, а первая загрузка за него не платит. Настройки,
 * диагностика, витрина, разделы-заглушки и мета игроку в первую минуту не
 * нужны.
 *
 * Каждый файл экранов — отдельный чанк; загрузчики вынесены, чтобы лобби
 * могло подтянуть их заранее в простое браузера.
 */
const loaders = {
  run: () => import("../screens/run/RunScreen"),
  settings: () => import("../screens/settings"),
  stubs: () => import("../screens/stubs"),
  gallery: () => import("../screens/gallery"),
  tasks: () => import("../screens/meta/tasks"),
  arsenal: () => import("../screens/meta/arsenal"),
  friends: () => import("../screens/meta/friends"),
  rating: () => import("../screens/meta/rating"),
  profile: () => import("../screens/meta/profile"),
  guide: () => import("../screens/guide/GuideScreen"),
  feedback: () => import("../screens/feedback"),
  daily: () => import("../screens/meta/daily"),
  wheel: () => import("../screens/meta/wheel"),
  stress: () => import("../screens/stress/StressScreen"),
  soundLab: () => import("../screens/sound-lab"),
  diagnostics: () => import("../screens/diagnostics"),
};

function screen<M, K extends keyof M>(load: () => Promise<M>, name: K): ComponentType {
  return lazy(async () => {
    const module = await load();
    return { default: module[name] as ComponentType };
  });
}

export const RunScreen = screen(loaders.run, "RunScreen");
export const SettingsScreen = screen(loaders.settings, "SettingsScreen");
export const TestersScreen = screen(loaders.settings, "TestersScreen");
export const AboutScreen = screen(loaders.settings, "AboutScreen");
export const DiagnosticsScreen = screen(loaders.diagnostics, "DiagnosticsScreen");
export const GalleryScreen = screen(loaders.gallery, "GalleryScreen");
export const ArsenalScreen = screen(loaders.arsenal, "ArsenalScreen");
export const ShopScreen = screen(loaders.stubs, "ShopScreen");
export const RatingScreen = screen(loaders.rating, "RatingScreen");
export const FriendsScreen = screen(loaders.friends, "FriendsScreen");
export const ProfileScreen = screen(loaders.profile, "ProfileScreen");
export const TasksScreen = screen(loaders.tasks, "TasksScreen");
export const DailyScreen = screen(loaders.daily, "DailyScreen");
export const WheelScreen = screen(loaders.wheel, "WheelScreen");
export const GuideScreen = screen(loaders.guide, "GuideScreen");
export const FeedbackScreen = screen(loaders.feedback, "FeedbackScreen");
export const StressScreen = screen(loaders.stress, "StressScreen");
export const SoundLabScreen = screen(loaders.soundLab, "SoundLabScreen");

/**
 * Подтянуть чанки экранов заранее. Неудача здесь не ошибка: экран попробует
 * загрузиться сам, когда игрок его откроет.
 */
export function preloadScreens(): void {
  for (const load of Object.values(loaders)) {
    load().catch(() => undefined);
  }
}

/**
 * Заглушка на время загрузки чанка. Проявляется с задержкой: на нормальной
 * сети чанк приходит быстрее, и мигание пустым экраном хуже, чем ничего.
 */
export function ScreenFallback(): ReactNode {
  return (
    <div className="flex h-full items-center justify-center" aria-busy="true">
      <span
        aria-hidden="true"
        className="animate-fade-in"
        style={{ animationDelay: "calc(var(--duration-slow) + var(--duration-base))" }}
      >
        <span className="block size-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </span>
    </div>
  );
}

interface BoundaryState {
  failed: boolean;
}

/**
 * Чанк экрана не пришёл — сеть пропала между лобби и нажатием. Без границы
 * ошибка ленивого экрана размонтировала бы всё приложение. Повтор —
 * перезагрузкой: неудачный динамический импорт браузер может запомнить, и
 * повторный импорт без перезагрузки упал бы снова.
 */
export class ScreenBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    reportError("screen", `экран не загрузился: ${String(error)}`);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <ErrorState text={t("error.screen")} onRetry={() => globalThis.location.reload()} />;
  }
}
