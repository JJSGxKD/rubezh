import { MILESTONES, START_KINDS, type Milestone, type Segment } from "../../api/broadcasts";
import { Field, Input, Select } from "../../ui/kit";

/**
 * Конструктор аудитории: вехи — «неважно / прошёл / не прошёл», источник
 * первого касания, давность. Всегда только тем, кому можно писать, — этого
 * флажка нет, его не снять.
 */
type Mark = "any" | "reached" | "notReached";

function markOf(segment: Segment, milestone: Milestone): Mark {
  if (segment.reached.includes(milestone)) return "reached";
  if (segment.notReached.includes(milestone)) return "notReached";
  return "any";
}

function withMark(segment: Segment, milestone: Milestone, mark: Mark): Segment {
  const reached = segment.reached.filter((item) => item !== milestone);
  const notReached = segment.notReached.filter((item) => item !== milestone);
  if (mark === "reached") reached.push(milestone);
  if (mark === "notReached") notReached.push(milestone);
  return { ...segment, reached, notReached };
}

/** Пустое поле — условие не задано. */
function daysOf(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

export function SegmentFields({ value, onChange, disabled = false }: { value: Segment; onChange: (next: Segment) => void; disabled?: boolean }) {
  const toggleKind = (kind: Segment["startKinds"][number]) =>
    onChange({ ...value, startKinds: value.startKinds.includes(kind) ? value.startKinds.filter((item) => item !== kind) : [...value.startKinds, kind] });

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
        {MILESTONES.map(([milestone, name]) => (
          <label key={milestone} className="flex items-center justify-between gap-2 text-sm">
            <span>{name}</span>
            <Select value={markOf(value, milestone)} disabled={disabled} onChange={(event) => onChange(withMark(value, milestone, event.target.value as Mark))}>
              <option value="any">неважно</option>
              <option value="reached">прошёл</option>
              <option value="notReached">не прошёл</option>
            </Select>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-text-muted">Пришёл (ничего не отмечено — любой):</span>
        {START_KINDS.map(([kind, name]) => (
          <label key={kind} className="flex items-center gap-1">
            <input type="checkbox" disabled={disabled} checked={value.startKinds.includes(kind)} onChange={() => toggleKind(kind)} />
            {name}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Кампания первого касания">
          <Input
            value={value.campaign ?? ""}
            disabled={disabled}
            placeholder="launch-post"
            maxLength={64}
            onChange={(event) => {
              const campaign = event.target.value.trim().toLowerCase();
              onChange({ ...value, campaign: campaign === "" ? undefined : campaign });
            }}
          />
        </Field>
        <Field label="Зарегистрировались за, дн.">
          <Input type="number" min={1} className="w-28" disabled={disabled} value={value.registeredWithinDays ?? ""} onChange={(event) => onChange({ ...value, registeredWithinDays: daysOf(event.target.value) })} />
        </Field>
        <Field label="Заходили за, дн.">
          <Input type="number" min={1} className="w-28" disabled={disabled} value={value.activeWithinDays ?? ""} onChange={(event) => onChange({ ...value, activeWithinDays: daysOf(event.target.value) })} />
        </Field>
        <Field label="Не заходят, дн.">
          <Input type="number" min={1} className="w-28" disabled={disabled} value={value.inactiveForDays ?? ""} onChange={(event) => onChange({ ...value, inactiveForDays: daysOf(event.target.value) })} />
        </Field>
        <Field label="Не писать получавшим за, дн. (0 — всем)">
          <Input type="number" min={0} max={90} className="w-28" disabled={disabled} value={value.skipRecentDays} onChange={(event) => onChange({ ...value, skipRecentDays: Number(event.target.value) })} />
        </Field>
      </div>
    </div>
  );
}
