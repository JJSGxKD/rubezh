import { useState, type ReactNode } from "react";
import { Dialog } from "./dialog";
import { Button } from "./kit";

/**
 * Окно формы создания и правки: список в разделе идёт первым, форма —
 * в окне (на телефоне листом снизу). Изменённую форму не закрыть случайно:
 * Escape, щелчок мимо и × сначала спрашивают.
 */

/** Значение в каноническом виде: ключи объектов по порядку, чтобы порядок не влиял. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonical(source[key])]),
    );
  }
  return value;
}

/**
 * Изменена ли форма: сравнение по значениям, без учёта порядка ключей.
 * `null` и пустая строка различаются — формы приводят пустое поле к `null`
 * сами, до сравнения.
 */
export function isDirty(initial: unknown, current: unknown): boolean {
  return JSON.stringify(canonical(initial)) !== JSON.stringify(canonical(current));
}

export function FormDialog({
  open,
  title,
  dirty,
  onClose,
  footer,
  wide = false,
  children,
}: {
  open: boolean;
  title: string;
  dirty: boolean;
  onClose: () => void;
  /** функция получает «закрыть с вопросом» — для кнопки «Отмена» */
  footer?: ReactNode | ((requestClose: () => void) => ReactNode);
  wide?: boolean;
  children: ReactNode;
}) {
  const [asking, setAsking] = useState(false);

  // Все пути закрытия (Escape, щелчок мимо, ×) приходят сюда одним вызовом.
  const requestClose = (): void => {
    if (dirty) setAsking(true);
    else onClose();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : requestClose())} title={title} size={wide ? "wide" : "default"} {...(footer === undefined ? {} : { footer: typeof footer === "function" ? footer(requestClose) : footer })}>
        {children}
      </Dialog>
      <Dialog
        open={open && asking}
        onOpenChange={(next) => (next ? undefined : setAsking(false))}
        title="Закрыть без сохранения?"
        description="Введённое пропадёт."
        footer={
          <>
            <Button onClick={() => setAsking(false)}>Вернуться</Button>
            <Button
              tone="danger"
              onClick={() => {
                setAsking(false);
                onClose();
              }}
            >
              Закрыть
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">Форма изменена, но не сохранена.</p>
      </Dialog>
    </>
  );
}
