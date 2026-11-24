import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { create } from "zustand";
import { t } from "../../i18n";
import "../../i18n/player-card";
import { track } from "../../state/shell";
import { uiFeedback } from "../../state/ui-feedback";
import { isPublicId, type CardFrom } from "./player-card-rules";

/**
 * Входы в карточку игрока из чужих экранов (tasks/T-0248, по образцу
 * `run-card-link.tsx`): строка рейтинга и сезона, ступень пьедестала, строка
 * друга, «Как меня видят» в профиле. Лежат отдельным небольшим файлом без самой
 * карточки: лист грузится по требованию, когда игрок нажал, а не вместе с
 * экраном (`pnpm budget`).
 *
 * Открытая карточка — одно значение в хранилище, а лист рисует `PlayerCardHost`
 * на экране-владельце. Так строка списка, лежащая глубоко в дереве и в витрине
 * компонентов, не тянет за собой состояние листа по пропсам.
 */

export interface CardTarget {
  publicId: string;
  from: CardFrom;
}

export const usePlayerCardTarget = create<{ target: CardTarget | null }>(() => ({ target: null }));

/**
 * Открыть карточку игрока. Строка, не похожая на публичный id (сервер до
 * публичных id, чужое значение), ничего не открывает: нажимаемой её и не
 * рисуют, а в путь запроса она не попадёт.
 */
export function openPlayerCard(publicId: string, from: CardFrom): void {
  if (!isPublicId(publicId)) return;
  usePlayerCardTarget.setState({ target: { publicId, from } });
  track("player_card_opened", { from });
}

export function closePlayerCard(): void {
  usePlayerCardTarget.setState({ target: null });
}

/**
 * Нажатие на строку или ступень пьедестала. Кнопка лежит поверх своей строки
 * (родитель — `relative`): разметка строки не меняется, а касание по всей
 * ширине открывает карточку игрока. Метки внутри строки не нажимаются сами.
 * Нет публичного id — кнопки нет, строка не нажимается (старый сервер).
 */
export function PlayerCardOpener(props: { publicId: string | undefined; name: string; from: CardFrom }): ReactNode {
  const { publicId } = props;
  if (publicId === undefined || !isPublicId(publicId)) return null;
  return (
    <button
      type="button"
      aria-label={t("playerCard.open", { name: props.name })}
      onClick={() => {
        uiFeedback("tap");
        openPlayerCard(publicId, props.from);
      }}
      className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:outline-accent active:bg-text/5"
    />
  );
}

/** Лист не загрузился (чанк не пришёл, нет сети): закрыть, а не оставить экран с пустым местом. */
function SheetUnavailable(props: { onClose: () => void }): ReactNode {
  const { onClose } = props;
  useEffect(onClose, [onClose]);
  return null;
}

interface SheetProps {
  publicId: string;
  from: CardFrom;
  onClose: () => void;
  onRemove?: (() => void) | undefined;
  onChanged?: (() => void) | undefined;
}

const PlayerCardSheetLazy = lazy(async (): Promise<{ default: (props: SheetProps) => ReactNode }> => {
  try {
    return { default: (await import("./player-card")).PlayerCardSheet };
  } catch {
    return { default: SheetUnavailable };
  }
});

/**
 * Лист открытой карточки на экране-владельце. Экран уходит — карточка
 * закрывается вместе с ним, иначе она открылась бы поверх чужого экрана.
 * `onRemove` — у экрана друзей: карточка друга предлагает убрать его из списка
 * тем же листом подтверждения, что и строка; `onChanged` — заявка ушла или
 * принята, экран перечитывает свой список.
 */
export function PlayerCardHost(props: { onRemove?: (publicId: string) => void; onChanged?: () => void }): ReactNode {
  const target = usePlayerCardTarget((state) => state.target);
  useEffect(() => closePlayerCard, []);
  if (target === null) return null;
  const { onRemove, onChanged } = props;
  return (
    <Suspense fallback={null}>
      <PlayerCardSheetLazy
        key={target.publicId}
        publicId={target.publicId}
        from={target.from}
        onClose={closePlayerCard}
        onRemove={target.from === "friends" && onRemove !== undefined ? () => onRemove(target.publicId) : undefined}
        onChanged={onChanged}
      />
    </Suspense>
  );
}
