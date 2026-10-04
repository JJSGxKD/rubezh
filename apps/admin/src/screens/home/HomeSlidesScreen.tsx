import { useState, type FormEvent, type ReactNode } from "react";
import type { ApiError } from "../../api/client";
import {
  AUDIENCE_TITLES,
  EDITABLE,
  ICON_TITLES,
  SCREEN_TITLES,
  SLIDE_PLATFORMS,
  SLIDE_PLATFORM_TITLES,
  SLIDE_STATE_TITLES,
  archiveSlide,
  audienceLabel,
  createSlide,
  crowded,
  draftOf,
  draftProblem,
  emptyDraft,
  fetchSlides,
  oneLine,
  targetLabel,
  updateSlide,
  type SlideCatalog,
  type SlideDraft,
  type TeamSlide,
} from "../../api/home-slides";
import { imageUrl } from "../../api/media";
import { formatDateTime } from "../../format";
import { api } from "../../services";
import { ChoiceCards } from "../../ui/choice";
import { HELP } from "../../ui/help";
import { ImageField } from "../../ui/image-field";
import { Badge, Button, DataTable, ErrorNotice, Field, Help, Input, Loading, Notice, Panel, Select } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

const STATE_TONES: Partial<Record<string, "success" | "info" | "neutral" | "warning">> = { active: "success", scheduled: "info", archived: "warning" };

/**
 * Главная (docs/35-stage4-plan.md WP42, часть 2): слайды команды в карусели
 * «Сейчас в игре». Правка видна игрокам в пределах полуминуты; снятый слайд
 * остаётся в списке — вернуть его нельзя, только завести новый.
 */
export function HomeSlidesScreen() {
  const { state, reload } = useApi(() => fetchSlides(api), []);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  return <HomeSlides catalog={state.data} reload={reload} />;
}

function HomeSlides({ catalog, reload }: { catalog: SlideCatalog; reload: () => void }) {
  const [editing, setEditing] = useState<TeamSlide | null>(null);
  const [draft, setDraft] = useState<SlideDraft>(() => emptyDraft(new Date()));
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  const { limits } = catalog;
  const problem = draftProblem(draft, limits, new Date(), editing !== null);
  const extra = crowded(catalog.slides, limits);

  const set = (patch: Partial<SlideDraft>) => setDraft({ ...draft, ...patch });
  const reset = () => {
    setEditing(null);
    setDraft(emptyDraft(new Date()));
  };
  const edit = (slide: TeamSlide) => {
    if (!EDITABLE.has(slide.state)) return;
    setEditing(slide);
    setDraft(draftOf(slide));
    setOutcome(null);
    // Форма — наверху: после клика по строке внизу длинного списка её иначе не видно.
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    setPending(true);
    const result = editing === null ? await createSlide(api, draft) : await updateSlide(api, editing.slideId, draft);
    setPending(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({
      tone: "success",
      text: editing === null ? `Слайд «${result.data.title}» заведён — игроки увидят его в течение полуминуты после начала` : `Слайд «${result.data.title}» сохранён — игроки увидят правку в течение полуминуты`,
    });
    reset();
    reload();
  };

  const archive = async (slide: TeamSlide) => {
    setConfirmArchive(null);
    const result = await archiveSlide(api, slide.slideId);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: `Слайд «${slide.title}» снят — из карусели он уйдёт в течение полуминуты` });
    if (editing?.slideId === slide.slideId) reset();
    reload();
  };

  const titleLength = oneLine(draft.title).length;
  const textLength = oneLine(draft.text).length;

  return (
    <div className="flex flex-col gap-4">
      <Panel title={editing === null ? "Новый слайд" : `Слайд «${editing.title}»`} help={HELP.home.section}>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Заголовок — ${String(titleLength)} из ${String(limits.titleMax)}`} help={HELP.home.title} error={titleLength > limits.titleMax ? "длиннее, чем влезет" : undefined}>
              <Input value={draft.title} onChange={(event) => set({ title: event.target.value })} maxLength={limits.titleMax + 10} placeholder="Турнир выходного дня" className="w-full" />
            </Field>
            <Field label={`Подпись — ${String(textLength)} из ${String(limits.textMax)}`} help={HELP.home.text} error={textLength > limits.textMax ? "длиннее, чем влезет" : undefined}>
              <Input value={draft.text} onChange={(event) => set({ text: event.target.value })} maxLength={limits.textMax + 10} placeholder="Лучшее время — в рейтинге" className="w-full" />
            </Field>
          </div>

          <div className="flex flex-wrap items-start gap-6">
            <ImageField label="Картинка" help={HELP.home.image} profile="home_slide" value={draft.imageId} onChange={(imageId) => set({ imageId })} />
            <Field label="Значок, если картинки нет" help={HELP.home.icon}>
              <Select value={draft.icon} onChange={(event) => set({ icon: event.target.value })}>
                {catalog.icons.map((icon) => (
                  <option key={icon} value={icon}>
                    {ICON_TITLES[icon] ?? icon}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <fieldset className="flex flex-col gap-2">
            <Legend help={HELP.home.target}>Куда ведёт</Legend>
            <div className="flex flex-wrap items-end gap-2">
              <Select aria-label="Куда ведёт" value={draft.targetKind} onChange={(event) => set({ targetKind: event.target.value === "link" ? "link" : "screen" })}>
                <option value="screen">Раздел игры</option>
                <option value="link">Ссылка</option>
              </Select>
              {draft.targetKind === "screen" ? (
                <Select aria-label="Раздел игры" value={draft.screen} onChange={(event) => set({ screen: event.target.value })}>
                  {catalog.screens.map((screen) => (
                    <option key={screen} value={screen}>
                      {SCREEN_TITLES[screen] ?? screen}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input aria-label="Ссылка" value={draft.url} onChange={(event) => set({ url: event.target.value })} placeholder="https://t.me/rubezh_game" maxLength={256} className="w-80" />
              )}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <Legend help={HELP.home.audience}>Кому</Legend>
            <ChoiceCards
              label="Кому"
              columns={3}
              value={draft.audience}
              onChange={(audience) => set({ audience })}
              choices={catalog.audiences.map((audience) => ({ value: audience, title: AUDIENCE_TITLES[audience]?.title ?? audience, description: AUDIENCE_TITLES[audience]?.description }))}
            />
          </fieldset>

          <fieldset className="flex flex-col gap-1">
            <Legend help={HELP.home.platforms}>Где</Legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1 py-1 text-sm">
              {SLIDE_PLATFORMS.map((platform) => (
                <label key={platform} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={draft.platforms.includes(platform)}
                    onChange={() => set({ platforms: draft.platforms.includes(platform) ? draft.platforms.filter((item) => item !== platform) : SLIDE_PLATFORMS.filter((item) => item === platform || draft.platforms.includes(item)) })}
                  />
                  {SLIDE_PLATFORM_TITLES[platform]}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-wrap items-end gap-3">
            <Field label="Начало" help={HELP.home.term} hint={editing === null ? "пусто — сразу" : undefined}>
              <Input type="datetime-local" value={draft.startsAt} onChange={(event) => set({ startsAt: event.target.value })} />
            </Field>
            <Field label="Конец" hint={`не дольше ${String(limits.maxDays)} дней`}>
              <Input type="datetime-local" value={draft.endsAt} onChange={(event) => set({ endsAt: event.target.value })} />
            </Field>
            <label className="flex items-center gap-1.5 pb-2 text-sm">
              <input type="checkbox" checked={draft.pinned} onChange={(event) => set({ pinned: event.target.checked })} />
              Первым в карусели
              <Help text={HELP.home.pinned} />
            </label>
          </div>

          <div className="flex gap-2">
            <Button tone="primary" type="submit" disabled={problem !== null || pending}>
              {editing === null ? "Завести" : "Сохранить"}
            </Button>
            {editing === null ? null : <Button onClick={reset}>Отмена</Button>}
          </div>
          {problem === null || (draft.title === "" && editing === null) ? null : <Notice tone="info">{problem}</Notice>}
        </form>
        {outcome === null ? null : <div className="mt-3">{outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}</div>}
      </Panel>

      <Panel title="Слайды" help={HELP.home.state}>
        {extra > 0 ? (
          <div className="mb-3">
            <Notice tone="warning">
              Идут {String(extra + limits.shownMax)} — в карусели разом не больше {String(limits.shownMax)}: игрок видит закреплённые, потом начавшиеся позже. Остальные ждут, пока
              первые кончатся.
            </Notice>
          </div>
        ) : null}
        <DataTable
          rows={catalog.slides}
          rowKey={(slide) => slide.slideId}
          onRowClick={edit}
          empty="Слайдов ещё не было — заведите первый выше"
          columns={[
            { title: "Слайд", render: (slide) => <SlideCell slide={slide} /> },
            { title: "Куда ведёт", render: (slide) => <span className="break-all">{targetLabel(slide)}</span> },
            { title: "Кому и где", render: (slide) => audienceLabel(slide) },
            { title: "Срок", render: (slide) => <span className="whitespace-nowrap">{`${formatDateTime(slide.startsAt)} — ${formatDateTime(slide.endsAt)}`}</span> },
            {
              title: "Состояние",
              render: (slide) => (
                <span className="inline-flex items-center gap-1.5">
                  <Badge tone={STATE_TONES[slide.state] ?? "neutral"}>{SLIDE_STATE_TITLES[slide.state] ?? slide.state}</Badge>
                  {slide.pinned ? <Badge tone="info">первым</Badge> : null}
                </span>
              ),
            },
            {
              title: "",
              render: (slide) => {
                if (!EDITABLE.has(slide.state)) return null;
                // Вернуть снятый нельзя — второе нажатие подтверждает.
                return (
                  // Нажатие по кнопке — не нажатие по строке: строка открыла бы правку.
                  <span className="flex gap-2" onClick={(event) => event.stopPropagation()}>
                    {confirmArchive === slide.slideId ? (
                      <>
                        <Button tone="danger" onClick={() => void archive(slide)}>
                          Да, снять
                        </Button>
                        <Button onClick={() => setConfirmArchive(null)}>Отмена</Button>
                      </>
                    ) : (
                      <>
                        <Button onClick={() => edit(slide)}>Изменить</Button>
                        <Button onClick={() => setConfirmArchive(slide.slideId)}>Снять</Button>
                      </>
                    )}
                  </span>
                );
              },
            },
          ]}
        />
      </Panel>
    </div>
  );
}

function Legend({ help, children }: { help: string; children: ReactNode }) {
  return (
    <legend className="flex items-center gap-1.5 text-xs text-text-muted">
      {children}
      <Help text={help} />
    </legend>
  );
}

/** Слайд в списке — картинкой и двумя строками, как у игрока, только мельче. */
function SlideCell({ slide }: { slide: TeamSlide }) {
  return (
    <span className="flex items-center gap-2">
      {slide.imageId === null ? (
        <span title={`Значок «${ICON_TITLES[slide.icon] ?? slide.icon}»`} className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-surface-sunken text-xs font-semibold text-text-muted">
          {(ICON_TITLES[slide.icon] ?? slide.icon).slice(0, 1)}
        </span>
      ) : (
        <img src={imageUrl(slide.imageId)} alt="" width={32} height={32} loading="lazy" className="size-8 shrink-0 rounded-sm bg-surface-sunken object-cover" />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{slide.title}</span>
        <span className="truncate text-xs text-text-muted">{slide.text}</span>
      </span>
    </span>
  );
}
