import { feeLabel, type Place } from "../../../api/ledger-chart";
import { formatAmount } from "../../../api/ledger";
import { Button, Panel } from "../../../ui/kit";

/**
 * Места хранения карточками: название, валюта, остаток, шаблон комиссии. Кнопки изменения — только с правом
 * `finance.entry.create`; отказ архива (остаток, служебное место) сервер называет словами — текст под кнопкой.
 */
export function PlacesView({
  places,
  canEdit,
  notes,
  onAdd,
  onEdit,
  onArchive,
}: {
  places: readonly Place[];
  canEdit: boolean;
  /** текст отказа под кнопкой «В архив», по идентификатору места */
  notes: Readonly<Record<string, string>>;
  onAdd: () => void;
  onEdit: (place: Place) => void;
  onArchive: (place: Place) => void;
}) {
  const live = places.filter((place) => !place.archived);
  return (
    <Panel title="Места хранения" help="Где лежат деньги проекта: карта, кошелёк, биржа. Комиссия места подставляется в переводы и обмены" actions={canEdit ? <Button onClick={onAdd}>Добавить место</Button> : undefined}>
      {live.length === 0 ? (
        <p className="text-sm text-text-muted">Мест хранения пока нет</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {live.map((place) => (
            <div key={place.placeId} className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3">
              <h3 className="text-sm font-semibold">{place.name}</h3>
              <p className="text-lg font-semibold tabular-nums">{formatAmount(place.balance, place.currency)}</p>
              <p className="text-xs text-text-muted">
                {place.currency} · комиссия: {feeLabel(place.fee)}
              </p>
              {canEdit ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => onEdit(place)}>Изменить</Button>
                  <Button onClick={() => onArchive(place)}>В архив</Button>
                </div>
              ) : null}
              {notes[place.placeId] === undefined ? null : (
                <p role="alert" className="text-xs text-danger">
                  {notes[place.placeId]}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
