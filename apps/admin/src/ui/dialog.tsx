import type { ReactNode } from "react";
import { Dialog as Primitive } from "radix-ui";

/**
 * Модальное окно панели на Radix: фокус заперт внутри, Escape и щелчок мимо
 * закрывают, фон не прокручивается. Длинная форма прокручивается внутри
 * окна, а заголовок и кнопки остаются на месте.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Primitive.Content
          // Без описания Radix ждёт явного отказа от него — иначе предупреждает в консоли.
          {...(description === undefined ? { "aria-describedby": undefined } : {})}
          className="fixed top-1/2 left-1/2 z-40 flex max-h-[90vh] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border-strong bg-surface shadow-panel focus:outline-none"
        >
          <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
            <div>
              <Primitive.Title className="text-base font-semibold">{title}</Primitive.Title>
              {description === undefined ? null : <Primitive.Description className="mt-0.5 text-xs text-text-muted">{description}</Primitive.Description>}
            </div>
            <Primitive.Close aria-label="Закрыть" className="rounded-sm px-2 text-lg leading-none text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">
              ×
            </Primitive.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer === undefined ? null : <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
