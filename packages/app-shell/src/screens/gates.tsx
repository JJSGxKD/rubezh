import type { ReactNode } from "react";
import { Maximize, Send, ShieldCheck } from "lucide-react";
import {
  Button,
  ContentColumn,
  Emblem,
  IconEmblem,
  ProgressBar,
  Wordmark,
} from "../design-system/components";
import { t } from "../i18n";

/**
 * Экраны запуска: пока приложение не готово к игре, игрок всё равно должен
 * видеть внятный экран, а не белый прямоугольник
 * (docs/27-design-system-and-app-shell.md §6).
 */

/**
 * Этапы запуска оболочки. Порядок — порядок в `mountAppShell`; полоса
 * показывает, сколько пройдено, а подпись — что происходит сейчас.
 */
export const BOOT_STAGES = ["platform", "fonts", "ready"] as const;
export type BootStage = (typeof BOOT_STAGES)[number];

/**
 * Заставка запуска. Раскладка повторяет заставку из index.html — знак, имя,
 * полоса, — поэтому смена статичной разметки на React не видна глазом, а
 * полоса продолжает движение с того места, где её оставила разметка.
 */
export function BootScreen(props: { stage: BootStage; version: string }): ReactNode {
  const done = BOOT_STAGES.indexOf(props.stage) + 1;

  return (
    <Centered still>
      <Emblem size={88} animated />
      <Wordmark size="l" />
      <div className="mt-4 w-48">
        <ProgressBar
          value={done}
          max={BOOT_STAGES.length}
          tone="accent"
          height="thin"
          shimmer
          label={t("app.loading")}
        />
      </div>
      <p className="min-h-5 text-xs text-text-muted">{t(`boot.stage.${props.stage}`)}</p>
      <p className="text-xs text-text-disabled">{t("app.version", { version: props.version })}</p>
    </Centered>
  );
}

/**
 * Открыто вне Telegram. Не ошибка, а объяснение: игру открывают по прямой
 * ссылке, и человек должен понять, куда идти.
 */
export function OutsideScreen(props: { botUrl: string }): ReactNode {
  return (
    <Centered>
      <Emblem size={72} animated />
      <h1 className="mt-2 font-display text-2xl font-bold text-text">{t("gate.outside.title")}</h1>
      <p className="max-w-[320px] text-sm text-text-muted">{t("gate.outside.text")}</p>
      {props.botUrl === "" ? null : (
        <Button glow onClick={() => globalThis.open(props.botUrl, "_blank")}>
          <Send size={18} />
          {t("gate.outside.action")}
        </Button>
      )}
    </Centered>
  );
}

/**
 * Клиент площадки слишком старый. Не «что-то пошло не так», а объяснение с
 * действием: на старом клиенте вертикальный свайп закрывает приложение прямо
 * посреди забега, и играть в него нельзя (docs/34-stage3-plan.md, Р11).
 */
export function OutdatedScreen(props: { version: string | null }): ReactNode {
  return (
    <Centered>
      <Emblem size={72} animated />
      <h1 className="mt-2 font-display text-2xl font-bold text-text">{t("gate.outdated.title")}</h1>
      <p className="max-w-[320px] text-sm text-text-muted">{t("gate.outdated.text")}</p>
      {props.version === null ? null : (
        <p className="text-xs text-text-disabled">{t("gate.outdated.version", { version: props.version })}</p>
      )}
    </Centered>
  );
}

/**
 * Компактный режим: приложение занимает часть экрана, играть в нём нельзя
 * (§5.2).
 *
 * Плашка ложится **поверх** приложения, а не вместо него. Подмена всего
 * дерева размонтировала экран забега вместе с движком, и вернувшийся игрок
 * получал не свой забег, а новый: четырнадцать минут исчезали ровно здесь.
 * Забег под плашкой стоит на паузе и ждёт.
 */
export function CompactOverlay(props: { onExpand(): void }): ReactNode {
  return (
    <div className="bg-app/95 absolute inset-0" style={{ zIndex: "var(--z-modal)" }}>
      <Centered>
        <IconEmblem tone="info">
          <Maximize size={24} />
        </IconEmblem>
        <h1 className="mt-2 font-display text-xl font-bold text-text">{t("gate.compact.title")}</h1>
        <p className="max-w-[320px] text-sm text-text-muted">{t("gate.compact.text")}</p>
        <Button glow onClick={props.onExpand}>
          {t("gate.compact.action")}
        </Button>
      </Centered>
    </div>
  );
}

/**
 * Первый запуск: короткое предупреждение о закрытом тесте и сборе технических
 * данных. Одна кнопка — это не согласие с юридическими последствиями, а
 * честность перед тестером.
 */
export function FirstRunScreen(props: { onAccept(): void }): ReactNode {
  return (
    <Centered>
      <Emblem size={72} animated />
      <div className="surface-panel mt-2 flex animate-pop-in flex-col items-center gap-3 rounded-xl p-5">
        <IconEmblem tone="info">
          <ShieldCheck size={24} />
        </IconEmblem>
        <h1 className="font-display text-xl font-bold text-text">{t("gate.firstRun.title")}</h1>
        <p className="max-w-[340px] text-sm text-text-muted">{t("gate.firstRun.text")}</p>
        <Button size="l" block glow onClick={props.onAccept}>
          {t("gate.firstRun.action")}
        </Button>
      </div>
    </Centered>
  );
}

/** `still` — без анимации появления: заставка подменяет статичную разметку и не должна мигать. */
function Centered(props: { children: ReactNode; still?: boolean }): ReactNode {
  return (
    <div className="bg-app flex h-full items-center justify-center overflow-y-auto px-6 pt-[var(--app-inset-top)] pb-[var(--app-inset-bottom)]">
      <ContentColumn>
        <div
          className={[
            "flex flex-col items-center gap-3 text-center",
            props.still === true ? "" : "animate-screen-in",
          ].join(" ")}
        >
          {props.children}
        </div>
      </ContentColumn>
    </div>
  );
}
