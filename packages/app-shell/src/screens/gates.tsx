import type { ReactNode } from "react";
import { Button, ContentColumn, ProgressBar } from "../design-system/components";
import { t } from "../i18n";

/**
 * Экраны запуска: пока приложение не готово к игре, игрок всё равно должен
 * видеть внятный экран, а не белый прямоугольник
 * (docs/27-design-system-and-app-shell.md §6).
 */

/** Заставка и загрузка. Разметка совпадает с той, что лежит в index.html. */
export function LoadingScreen(props: { version: string }): ReactNode {
  return (
    <Centered>
      <h1 className="font-display text-3xl text-text">{t("app.name")}</h1>
      <div className="w-40">
        <ProgressBar value={1} max={3} tone="accent" height="thin" label={t("app.loading")} />
      </div>
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
      <h1 className="font-display text-xl text-text">{t("gate.outside.title")}</h1>
      <p className="max-w-[320px] text-sm text-text-muted">{t("gate.outside.text")}</p>
      {props.botUrl === "" ? null : (
        <Button onClick={() => globalThis.open(props.botUrl, "_blank")}>
          {t("gate.outside.action")}
        </Button>
      )}
    </Centered>
  );
}

/**
 * Компактный режим: приложение занимает часть экрана. Забег в нём непригоден,
 * поэтому вместо него — просьба развернуть и кнопка, которая это делает (§5.2).
 */
export function CompactScreen(props: { onExpand(): void }): ReactNode {
  return (
    <Centered>
      <h1 className="font-display text-xl text-text">{t("gate.compact.title")}</h1>
      <p className="max-w-[320px] text-sm text-text-muted">{t("gate.compact.text")}</p>
      <Button onClick={props.onExpand}>{t("gate.compact.action")}</Button>
    </Centered>
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
      <h1 className="font-display text-xl text-text">{t("gate.firstRun.title")}</h1>
      <p className="max-w-[340px] text-sm text-text-muted">{t("gate.firstRun.text")}</p>
      <Button onClick={props.onAccept}>{t("gate.firstRun.action")}</Button>
    </Centered>
  );
}

function Centered(props: { children: ReactNode }): ReactNode {
  return (
    <div className="flex h-full items-center justify-center px-6 pt-[var(--app-inset-top)] pb-[var(--app-inset-bottom)]">
      <ContentColumn>
        <div className="flex flex-col items-center gap-4 text-center">{props.children}</div>
      </ContentColumn>
    </div>
  );
}
